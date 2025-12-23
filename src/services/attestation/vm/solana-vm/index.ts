import * as anchor from "@coral-xyz/anchor";
import { BorshInstructionCoder, Idl, Program } from "@coral-xyz/anchor";
import {
  DecodedSolanaVmWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@reservoir0x/relay-protocol-sdk";
import { MEMO_PROGRAM_ID } from "@solana/spl-memo";
import {
  PublicKey,
  Connection,
  VersionedTransactionResponse,
  MessageCompiledInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { RelayDepositoryIdl } from "./idls/RelayDepositoryIdl";
import { getDeterministicId } from "../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/solana-vm/rpc";

const VM_TYPE = "solana-vm";

// dummy comment
export class SolanaVmAttestor extends VmAttestor {
  private readonly instructionCoder: BorshInstructionCoder;

  constructor() {
    super();

    this.instructionCoder = new BorshInstructionCoder(
      RelayDepositoryIdl as Idl
    );
  }

  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<EnhancedDepositoryDepositMessage[]> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId, "finalized");

    await logRpcUsage(chainId, "getTransaction", trackingId);
    const transaction = await rpc.getTransaction(transactionId, {
      maxSupportedTransactionVersion: 0,
      // Ensure the transaction is finalized
      commitment: "finalized",
    });
    if (!transaction) {
      return [];
    }

    // Get the timestamp of the transaction
    await logRpcUsage(chainId, "getBlock", trackingId);
    const timestamp = await rpc
      .getBlock(transaction.slot, {
        maxSupportedTransactionVersion: 0,
        // Ensure the block is finalized
        commitment: "finalized",
      })
      .then((b) => b?.blockTime);
    if (!timestamp) {
      throw externalError("Could not fetch the timestamp of the transaction");
    }

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    const { instructions, accountKeys } =
      await this._extractInstructionsAndKeys(
        chainId,
        transaction,
        rpc,
        trackingId
      );
    if (!instructions.length) {
      return [];
    }

    const messages: EnhancedDepositoryDepositMessage[] = [];

    // Iterate through all instructions, looking for calls to the depository contract
    for (let i = 0; i < instructions.length; i++) {
      const instruction = instructions[i];
      const programId = accountKeys[instruction.programIdIndex];

      // Check if this is a call to the depository contract
      if (programId.toBase58() === depository) {
        const data = Buffer.from(instruction.data);

        const decodedInstruction = this.instructionCoder.decode(data);
        if (!decodedInstruction) {
          continue;
        }

        if (decodedInstruction.name === "deposit_native") {
          // Handle "deposit_native" instruction

          const { amount, id } = decodedInstruction.data as {
            amount: anchor.BN;
            id: number[];
          };

          // Get relevant accounts
          const depositorIndex = instruction.accountKeyIndexes[2];
          // Third account in "DepositToken" struct is the depositor
          const depositor = accountKeys[depositorIndex].toBase58();

          const onchainId = getDeterministicId(
            chainId,
            transactionId,
            i.toString()
          );
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
              currency: getVmTypeNativeCurrency(VM_TYPE),
              amount: amount.toString(),
            },
            extraData: {
              timestamp: String(timestamp),
            },
          });
        } else if (decodedInstruction.name === "deposit_token") {
          // Handle "deposit_token" instruction

          const { amount, id } = decodedInstruction.data as {
            amount: anchor.BN;
            id: number[];
          };

          // Get relevant accounts
          // Third account in "DepositToken" struct is the depositor
          const depositorIndex = instruction.accountKeyIndexes[2];
          // Fifth account in "DepositToken" struct is the mint
          const mintIndex = instruction.accountKeyIndexes[4];

          const depositor = accountKeys[depositorIndex].toBase58();
          const mint = accountKeys[mintIndex].toBase58();

          const onchainId = getDeterministicId(
            chainId,
            transactionId,
            i.toString()
          );
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
            extraData: {
              timestamp: String(timestamp),
            },
          });
        }
      }
    }

    return messages;
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
    const trackingId = getTrackingId();

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
      await logRpcUsage(chainId, "fetch", trackingId);
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
      await logRpcUsage(chainId, "getSlot", trackingId);
      await logRpcUsage(chainId, "getBlockTime", trackingId);
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
      orderId: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint> {
    const trackingId = getTrackingId();

    const rpc = await httpRpc(chainId);

    // Get the transaction details
    await logRpcUsage(chainId, "getTransaction", trackingId);
    const transaction = await rpc.getTransaction(transactionId, {
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

    const { instructions, accountKeys } =
      await this._extractInstructionsAndKeys(
        chainId,
        transaction,
        rpc,
        trackingId
      );

    let hasOrderId = false;
    for (const instruction of instructions) {
      const programId = accountKeys[instruction.programIdIndex];
      if (programId.toBase58() === MEMO_PROGRAM_ID.toBase58()) {
        const ixData = Buffer.from(instruction.data).toString();
        if (ixData.includes(payment.orderId)) {
          hasOrderId = true;
          break;
        }
      }
    }

    if (!hasOrderId) {
      throw externalError(
        `Transaction ${transactionId} does not reference order id`
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

  private async _extractInstructionsAndKeys(
    chainId: string,
    transaction: VersionedTransactionResponse,
    rpc: Connection,
    trackingId: string
  ): Promise<{
    instructions: MessageCompiledInstruction[];
    accountKeys: PublicKey[];
  }> {
    if (!transaction.transaction?.message || !transaction.meta) {
      return {
        instructions: [],
        accountKeys: [],
      };
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
            async ({ accountKey }) => {
              await logRpcUsage(chainId, "getAddressLookupTable", trackingId);
              return rpc
                .getAddressLookupTable(accountKey)
                .then((res) => res.value!);
            }
          )
        ),
      }).staticAccountKeys,
      // First we have `writable` and then `readonly`
      ...(transaction.meta?.loadedAddresses?.writable ?? []),
      ...(transaction.meta?.loadedAddresses?.readonly ?? []),
    ];

    return { instructions, accountKeys };
  }
}
