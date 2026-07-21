import * as anchor from "@coral-xyz/anchor";
import { BorshInstructionCoder, Idl, Program } from "@coral-xyz/anchor";
import {
  DecodedSolanaVmWithdrawal,
  decodeWithdrawal,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk";
import { MEMO_PROGRAM_ID } from "@solana/spl-memo";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TokenInstruction,
  decodeTransferInstruction,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  Connection,
  SystemProgram,
  SystemInstruction,
  ComputeBudgetProgram,
  TransactionInstruction,
  VersionedTransactionResponse,
  MessageCompiledInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { RelayDepositoryIdl } from "./idls/RelayDepositoryIdl";
import { getDeterministicId } from "../../utils";
import { EnhancedDepositoryDepositMessage, VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { logger } from "../../../../common/logger";
import { getTrackingId, logRpcUsage } from "../../../../common/rpc-usage";
import { httpRpc } from "../../../../common/vm/solana-vm/rpc";

const VM_TYPE = "solana-vm";

// Direct transfers do not carry a deposit id, so we use the zero hash
const ZERO_DEPOSIT_ID = "0x" + "0".repeat(64);

export class SolanaVmAttestor extends VmAttestor {
  private readonly instructionCoder: BorshInstructionCoder;

  constructor() {
    super();

    this.instructionCoder = new BorshInstructionCoder(
      RelayDepositoryIdl as Idl,
    );
  }

  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string,
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
    if (transaction.meta?.err) {
      throw externalError(`Transaction failed: ${transactionId}`);
    }

    // Get the timestamp of the transaction
    await logRpcUsage(chainId, "getBlock", trackingId);
    const timestamp =
      transaction.blockTime ??
      (await rpc
        .getBlock(transaction.slot, {
          maxSupportedTransactionVersion: 0,
          // Ensure the block is finalized
          commitment: "finalized",
        })
        .catch((error: any) => {
          logger.warn(
            VM_TYPE,
            `getBlock transient error: chainId=${chainId} transactionId=${transactionId} slot=${transaction.slot} code=${error?.code} message=${error?.message}`,
          );
          throw error;
        })
        .then((b) => b?.blockTime));
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
        trackingId,
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
            i.toString(),
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
            i.toString(),
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

    // If no deposits were made through the depository program, check for a direct
    // transfer (SOL or SPL) to the depository vault. For safety, this only recognizes
    // a deposit when the whole transaction contains a single instruction and that
    // instruction is a transfer (a System `transfer`, or an SPL token `transfer` /
    // `transferChecked`) targeting the vault. Direct transfers do not carry a deposit
    // id, so the zero hash is used.
    // Ignore ComputeBudget instructions (e.g. priority-fee settings) when determining
    // whether the transaction is a single direct transfer; none of them move funds
    const relevantInstructions = instructions.filter(
      (compiledInstruction) =>
        accountKeys[compiledInstruction.programIdIndex].toBase58() !==
        ComputeBudgetProgram.programId.toBase58(),
    );

    if (!messages.length && relevantInstructions.length === 1) {
      const compiledInstruction = relevantInstructions[0];
      const programId = accountKeys[compiledInstruction.programIdIndex];

      // Reconstruct a `TransactionInstruction` so we can use the standard decoders
      const instruction = new TransactionInstruction({
        programId,
        keys: compiledInstruction.accountKeyIndexes.map((index) => ({
          pubkey: accountKeys[index],
          isSigner: false,
          isWritable: false,
        })),
        data: Buffer.from(compiledInstruction.data),
      });

      const onchainId = getDeterministicId(chainId, transactionId, "0");

      const [depositoryVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault")],
        new PublicKey(depository),
      );

      // Handle the single instruction if it is a transfer to the vault (the
      // transaction is already known to have succeeded, so a transfer instruction
      // is guaranteed to be well-formed and decodable)
      if (
        programId.equals(SystemProgram.programId) &&
        SystemInstruction.decodeInstructionType(instruction) === "Transfer"
      ) {
        // Native SOL transfer: the destination must be the vault PDA
        const { fromPubkey, toPubkey, lamports } =
          SystemInstruction.decodeTransfer(instruction);
        if (toPubkey.equals(depositoryVault)) {
          messages.push({
            data: {
              chainId,
              transactionId,
            },
            result: {
              onchainId,
              depositId: ZERO_DEPOSIT_ID,
              depository,
              depositor: fromPubkey.toBase58(),
              currency: getVmTypeNativeCurrency(VM_TYPE),
              amount: lamports.toString(),
            },
            extraData: {
              timestamp: String(timestamp),
            },
          });
        }
      } else if (
        programId.equals(TOKEN_PROGRAM_ID) ||
        programId.equals(TOKEN_2022_PROGRAM_ID)
      ) {
        // SPL token `transfer` / `transferChecked`
        const type =
          instruction.data.length >= 1 ? instruction.data.readUInt8(0) : -1;

        let destination: PublicKey | undefined;
        let authority: PublicKey | undefined;
        let mint: PublicKey | undefined;
        let amount: bigint | undefined;
        if (type === TokenInstruction.Transfer) {
          const { keys, data } = decodeTransferInstruction(
            instruction,
            programId,
          );
          destination = keys.destination.pubkey;
          authority = keys.owner.pubkey;
          amount = data.amount;
        } else if (type === TokenInstruction.TransferChecked) {
          const { keys, data } = decodeTransferCheckedInstruction(
            instruction,
            programId,
          );
          destination = keys.destination.pubkey;
          authority = keys.owner.pubkey;
          mint = keys.mint.pubkey;
          amount = data.amount;
        }

        if (destination && authority && amount) {
          // A legacy `transfer` does not include the mint, so fetch it from the
          // destination token account
          if (!mint) {
            await logRpcUsage(chainId, "getParsedAccountInfo", trackingId);
            const accountData = await rpc
              .getParsedAccountInfo(destination)
              .then((res) => res.value?.data);
            if (accountData && !Buffer.isBuffer(accountData)) {
              const parsedMint = accountData.parsed?.info?.mint;
              if (parsedMint) {
                mint = new PublicKey(parsedMint);
              }
            }
          }

          // The destination must be the vault's associated token account (the ATA
          // address commits to the vault being the token account owner)
          if (
            mint &&
            destination.equals(
              getAssociatedTokenAddressSync(
                mint,
                depositoryVault,
                true,
                programId,
              ),
            )
          ) {
            // Token-2022 supports fee-on-transfer, so the vault token account may
            // receive less than the instruction amount; credit the actual balance
            // increase if it is lower (the legacy SPL token program has no such fee)
            if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
              const destinationKey = destination.toBase58();
              const destIndex = accountKeys.findIndex(
                (key) => key.toBase58() === destinationKey,
              );
              const preAmount = transaction.meta?.preTokenBalances?.find(
                (b) => b.accountIndex === destIndex,
              )?.uiTokenAmount.amount;
              const postAmount = transaction.meta?.postTokenBalances?.find(
                (b) => b.accountIndex === destIndex,
              )?.uiTokenAmount.amount;
              if (postAmount !== undefined) {
                const balanceDiff =
                  BigInt(postAmount) - BigInt(preAmount ?? "0");
                if (balanceDiff < amount) {
                  amount = balanceDiff;
                }
              }
            }

            messages.push({
              data: {
                chainId,
                transactionId,
              },
              result: {
                onchainId,
                depositId: ZERO_DEPOSIT_ID,
                depository,
                depositor: authority.toBase58(),
                currency: mint.toBase58(),
                amount: amount.toString(),
              },
              extraData: {
                timestamp: String(timestamp),
              },
            });
          }
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
    withdrawal: string,
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
      chain.vmType,
    ) as DecodedSolanaVmWithdrawal;
    const withdrawalId = getDecodedWithdrawalId(decodedWithdrawal);

    const program = new Program(
      {
        ...RelayDepositoryIdl,
        address: depository,
      } as Idl,
      new anchor.AnchorProvider(
        new anchor.web3.Connection(rpc.rpcEndpoint, "finalized"),
        new anchor.Wallet(anchor.web3.Keypair.generate()),
      ),
    );

    const [usedRequestPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("used_request"), Buffer.from(withdrawalId.slice(2), "hex")],
      program.programId,
    );

    let usedRequestState: { isUsed: boolean } | undefined;
    try {
      await logRpcUsage(chainId, "fetch", trackingId);
      usedRequestState = await (program.account as any).usedRequest.fetch(
        usedRequestPda,
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
    },
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
        `Transaction executed after deadline: ${payment.deadline}`,
      );
    }

    const { instructions, accountKeys } =
      await this._extractInstructionsAndKeys(
        chainId,
        transaction,
        rpc,
        trackingId,
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
        `Transaction ${transactionId} does not reference order id`,
      );
    }

    // For native SOL transfers
    if (payment.currency === "11111111111111111111111111111111") {
      const recipientPubkey = new PublicKey(payment.recipient);
      const recipientIndex = accountKeys.findIndex((key) =>
        key.equals(recipientPubkey),
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
          b.mint === tokenMintPubkey.toBase58(),
      );

      const postTokenBalance = transaction.meta?.postTokenBalances?.find(
        (b) =>
          b.owner === recipientPubkey.toBase58() &&
          b.mint === tokenMintPubkey.toBase58(),
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
    _extraData: string,
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

  private async _extractInstructionsAndKeys(
    chainId: string,
    transaction: VersionedTransactionResponse,
    rpc: Connection,
    trackingId: string,
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
            },
          ),
        ),
      }).staticAccountKeys,
      // First we have `writable` and then `readonly`
      ...(transaction.meta?.loadedAddresses?.writable ?? []),
      ...(transaction.meta?.loadedAddresses?.readonly ?? []),
    ];

    return { instructions, accountKeys };
  }
}
