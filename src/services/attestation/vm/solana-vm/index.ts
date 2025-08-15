import * as anchor from "@coral-xyz/anchor";
import { BorshEventCoder, BorshInstructionCoder, Idl, Program } from "@coral-xyz/anchor";
import {
  DecodedSolanaVmWithdrawal,
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
} from "@reservoir0x/relay-protocol-sdk";
import { MEMO_PROGRAM_ID } from "@solana/spl-memo";
import { PublicKey, SystemProgram, Connection, VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";

import { RelayDepositoryIdl } from "./idls/RelayDepositoryIdl";
import { getOnchainId } from "../utils";
import { VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/solana-vm/rpc";

export class SolanaVmAttestor extends VmAttestor {
  private readonly eventCoder: BorshEventCoder;
  private readonly instructionCoder: BorshInstructionCoder;
  private enableLogs: boolean;

  constructor() {
    super();

    this.eventCoder = new BorshEventCoder(RelayDepositoryIdl as Idl);
    this.instructionCoder = new BorshInstructionCoder(RelayDepositoryIdl as Idl);
    this.enableLogs = false;
  }

  /**
   * Get depository deposit messages from a transaction.
   * 
   * This function first tries to parse events from logs. If log parsing fails or logs are truncated, 
   * it tries parsing from instructions.
   * 
   * @param chainId The ID of the chain.
   * @param transactionId The ID of the transaction.
   * @returns A list of depository deposit messages.
   */
  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<DepositoryDepositMessage[]> {
    const rpc = await httpRpc(chainId, "finalized");

    const transaction = await rpc.getTransaction(transactionId, {
      maxSupportedTransactionVersion: 0,
      // Ensure the transaction is finalized
      commitment: "finalized",
    });
    if (!transaction) {
      return [];
    }

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    if (this.enableLogs && transaction.meta?.logMessages) {
      const messagesFromLogs = this._parseTransactionLogs(
        chainId,
        transactionId,
        transaction.meta.logMessages,
        depository
      );
      
      if (messagesFromLogs.length > 0) {
        return messagesFromLogs;
      }
    }

    // Parsing from instructions
    return await this._parseTransactionInstructions(
      chainId,
      transactionId,
      transaction,
      depository,
      rpc
    );
  }

  /**
   * Get depository withdrawal message from a withdrawal.
   * 
   * @param chainId The ID of the chain.
   * @param withdrawal The withdrawal.
   * @returns A depository withdrawal message.
   */
  public async getDepositoryWithdrawalMessage(
    chainId: string,
    withdrawal: string
  ): Promise<DepositoryWithdrawalMessage> {
    const rpc = await httpRpc(chainId, "finalized");
    const chain = await getChain(chainId);

    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const decodedWithdrawal = decodeWithdrawal(
      withdrawal,
      chain.vmType
    ) as DecodedSolanaVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    const program = new Program(
      {
        ...RelayDepositoryIdl,
        address: depository,
      } as Idl,
      new anchor.AnchorProvider(
        new anchor.web3.Connection(rpc.rpcEndpoint, "finalized"),
        new anchor.Wallet(anchor.web3.Keypair.generate())
      )
    );

    const [usedRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), Buffer.from(withdrawalId.slice(2), "hex")],
      program.programId
    );

    let usedRequestState: { isUsed: boolean } | undefined;
    try {
      usedRequestState = await (program.account as any).usedRequest.fetch(
        usedRequestPda
      );
    } catch {
      // Skip errors (`usedRequestState` will be undefined if not found)
    }

    let status: DepositoryWithdrawalStatus;
    if (usedRequestState && usedRequestState.isUsed) {
      status = DepositoryWithdrawalStatus.EXECUTED;
    } else {
      const chainTimestamp = await rpc.getBlockTime(await rpc.getSlot());
      if (!chainTimestamp) {
        throw internalError("Failed to fetch Solana block time");
      }
      if (
        BigInt(chainTimestamp) > BigInt(decodedWithdrawal.withdrawal.expiration)
      ) {
        status = DepositoryWithdrawalStatus.EXPIRED;
      } else {
        status = DepositoryWithdrawalStatus.PENDING;
      }
    }

    return {
      data: {
        chainId,
        withdrawal,
      },
      result: {
        withdrawalId,
        depository,
        status,
      },
    };
  }

  /**
   * Get solver paid amount from a transaction.
   * 
   * @param chainId The ID of the chain.
   * @param transactionId The ID of the transaction.
   * @param payment The payment.
   * @returns The solver paid amount.
   */
  public async getSolverPaidAmount(
    chainId: string,
    transactionId: string,
    payment: {
      currency: string;
      recipient: string;
      orderHash: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint> {
    const connection = await httpRpc(chainId);

    // Get the transaction details
    const transaction = await connection.getTransaction(transactionId, {
      maxSupportedTransactionVersion: 0,
      // Ensure the transaction is finalized
      commitment: "finalized",
    });
    if (!transaction) {
      throw externalError(`Missing transaction: ${transactionId}`);
    }
    if (transaction.meta?.err) {
      throw externalError(`Transaction failed: ${transactionId}`);
    }

    // Check deadline
    if (transaction.blockTime && transaction.blockTime > payment.deadline) {
      throw externalError(
        `Transaction executed after deadline: ${payment.deadline}`
      );
    }

    const { instructions, accountKeys } = await this._extractInstructionsAndKeys(transaction, connection);

    let hasOrderHash = false;
    for (const instruction of instructions) {
      const programId = accountKeys[instruction.programIdIndex];
      if (programId.toBase58() === MEMO_PROGRAM_ID.toBase58()) {
        const ixData = Buffer.from(instruction.data).toString();
        if (ixData.includes(payment.orderHash)) {
          hasOrderHash = true;
          break;
        }
      }
    }

    if (!hasOrderHash) {
      throw externalError(
        `Transaction ${transactionId} does not reference order hash`
      );
    }

    // For native SOL transfers
    if (payment.currency === "11111111111111111111111111111111") {
      const recipientPubkey = new PublicKey(payment.recipient);
      const recipientIndex = accountKeys.findIndex((key) =>
        key.equals(recipientPubkey)
      );
      if (recipientIndex === -1) {
        return 0n;
      }

      const preBalance = transaction.meta?.preBalances?.[recipientIndex] || 0;
      const postBalance = transaction.meta?.postBalances?.[recipientIndex] || 0;
      return BigInt(postBalance) - BigInt(preBalance);
    } else {
      // For SPL token transfers
      const recipientPubkey = new PublicKey(payment.recipient);
      const tokenMintPubkey = new PublicKey(payment.currency);

      // Find pre and post token balances for the recipient and token
      const preTokenBalance = transaction.meta?.preTokenBalances?.find(
        (b) =>
          b.owner === recipientPubkey.toBase58() &&
          b.mint === tokenMintPubkey.toBase58()
      );

      const postTokenBalance = transaction.meta?.postTokenBalances?.find(
        (b) =>
          b.owner === recipientPubkey.toBase58() &&
          b.mint === tokenMintPubkey.toBase58()
      );

      if (!preTokenBalance && !postTokenBalance) {
        return 0n;
      }

      const preAmount = preTokenBalance
        ? BigInt(preTokenBalance.uiTokenAmount.amount)
        : 0n;
      const postAmount = postTokenBalance
        ? BigInt(postTokenBalance.uiTokenAmount.amount)
        : 0n;

      return postAmount - preAmount;
    }
  }

  /**
   * Verify solver calls.
   * 
   * @param _chainId The ID of the chain.
   * @param _transactionId The ID of the transaction.
   * @param _calls The calls.
   * @param _extraData The extra data.
   * @returns Whether the solver calls are valid.
   */
  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

  /**
   * Extract all instructions and account keys from a transaction
   * 
   * @param transaction The transaction object
   * @returns Object containing instructions and account keys
   */
  private async _extractInstructionsAndKeys(transaction: VersionedTransactionResponse, connection: Connection): Promise<{ 
    instructions: any[],
    accountKeys: any[]
  }> {
    if (!transaction.transaction?.message || !transaction.meta) {
      return { instructions: [], accountKeys: [] };
    }
    
    const message = transaction.transaction.message;
    const instructions = [
      ...message.compiledInstructions,
      // Include any inner instructions
      ...(transaction.meta?.innerInstructions ?? [])
        .map((i) => i.instructions)
        .flat()
        .map((i) => ({
          accountKeyIndexes: i.accounts,
          programIdIndex: i.programIdIndex,
          data: bs58.decode(i.data),
        })),
    ];

    const accountKeys = [
      ...message.getAccountKeys({
        addressLookupTableAccounts: await Promise.all(
          (transaction.transaction.message.addressTableLookups ?? []).map(
            async ({ accountKey }) =>
              await connection
                .getAddressLookupTable(accountKey)
                .then((res) => res.value!)
          )
        ),
      }).staticAccountKeys,
      // First we have `writable` and then `readonly`
      ...(transaction.meta?.loadedAddresses?.writable ?? []),
      ...(transaction.meta?.loadedAddresses?.readonly ?? []),
    ];

    return { instructions, accountKeys };
  }

  /**
   * Parse transaction logs to get depository deposit messages.
   * 
   * @param chainId The ID of the chain.
   * @param transactionId The ID of the transaction.
   * @param logs The transaction logs.
   * @param depository The depository.
   * @returns A list of depository deposit messages.
   */
  private _parseTransactionLogs(
    chainId: string,
    transactionId: string,
    logs: string[],
    depository: string
  ): DepositoryDepositMessage[] {
    const messages: DepositoryDepositMessage[] = [];

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (!log.startsWith("Program data: ")) {
        continue;
      }

      try {
        const event = this.eventCoder.decode(
          log.slice("Program data: ".length)
        );
        if (!event) {
          continue;
        }

        if (event.name === "DepositEvent") {
          const eventData = event.data as {
            depositor: PublicKey;
            token: PublicKey | null;
            amount: bigint;
            id: number[];
          };

          const onchainId = getOnchainId(chainId, transactionId, i.toString());
          messages.push({
            data: {
              chainId,
              transactionId,
            },
            result: {
              onchainId,
              depositId: "0x" + Buffer.from(eventData.id).toString("hex"),
              depository,
              depositor: eventData.depositor.toBase58(),
              currency: eventData.token
                ? eventData.token.toBase58()
                : SystemProgram.programId.toBase58(),
              amount: eventData.amount.toString(),
            },
          });
        }
      } catch {
        // Skip errors
      }
    }

    return messages;
  }

  /**
   * Parse transaction instructions to get depository deposit messages.
   * 
   * @param chainId The ID of the chain.
   * @param transactionId The ID of the transaction.
   * @param transaction The transaction.
   * @param depository The depository.
   * @returns A list of depository deposit messages.
   */
  private async _parseTransactionInstructions(
    chainId: string,
    transactionId: string,
    transaction: VersionedTransactionResponse,
    depository: string,
    connection: Connection,
  ): Promise<DepositoryDepositMessage[]> {
    const messages: DepositoryDepositMessage[] = [];
    const { instructions, accountKeys } = await this._extractInstructionsAndKeys(transaction, connection);
    
    if (instructions.length === 0) {
      return messages;
    }

    // Iterate through all instructions, looking for calls to the depository contract
    for (let i = 0; i < instructions.length; i++) {
      const instruction = instructions[i];
      const programId = accountKeys[instruction.programIdIndex];
      
      // Check if this is a call to the depository contract
      if (programId.toBase58() === depository) {
        try {
          const data = Buffer.from(instruction.data);
          const decodedInstruction = this.instructionCoder.decode(data);
          
          if (!decodedInstruction) {
            continue;
          }

          // Handle deposit_native instruction
          if (decodedInstruction.name === 'deposit_native') {
            const { amount, id } = decodedInstruction.data as { amount: anchor.BN, id: number[] };
            
            // Get relevant accounts
            const depositorIndex = instruction.accountKeyIndexes[2]; // Third account in DepositNative struct is depositor
            const depositor = accountKeys[depositorIndex].toBase58();
            
            const onchainId = getOnchainId(chainId, transactionId, i.toString());
            messages.push({
              data: {
                chainId,
                transactionId,
              },
              result: {
                onchainId,
                depositId: "0x" + Buffer.from(id).toString("hex"),
                depository,
                depositor,
                currency: SystemProgram.programId.toBase58(), // Native SOL currency is the system program ID
                amount: amount.toString(),
              },
            });
          } 
          // Handle deposit_token instruction
          else if (decodedInstruction.name === 'deposit_token') {
            const { amount, id } = decodedInstruction.data as { amount: anchor.BN, id: number[] };
            
            // Get relevant accounts
            const depositorIndex = instruction.accountKeyIndexes[2]; // Third account in DepositToken struct is depositor
            const mintIndex = instruction.accountKeyIndexes[4]; // Fifth account in DepositToken struct is mint
            
            const depositor = accountKeys[depositorIndex].toBase58();
            const mint = accountKeys[mintIndex].toBase58();
            
            const onchainId = getOnchainId(chainId, transactionId, i.toString());
            messages.push({
              data: {
                chainId,
                transactionId,
              },
              result: {
                onchainId,
                depositId: "0x" + Buffer.from(id).toString("hex"),
                depository,
                depositor,
                currency: mint,
                amount: amount.toString(),
              },
            });
          }
        } catch (e) {
          // Skip parsing errors
        }
      }
    }

    return messages;
  }
}
