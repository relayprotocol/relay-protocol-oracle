import * as anchor from "@coral-xyz/anchor";
import { BorshEventCoder, Idl, Program } from "@coral-xyz/anchor";
import {
  DecodedSolanaVmWithdrawal,
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
} from "@reservoir0x/relay-protocol-sdk";
import { MEMO_PROGRAM_ID } from "@solana/spl-memo";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";

import { RelayDepositoryIdl } from "./idls/RelayDepositoryIdl";
import { getOnchainId } from "../utils";
import { VmAttestor } from "../../vm/types";
import { getChain } from "../../../../common/chains";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/solana-vm/rpc";

export class SolanaVmAttestor extends VmAttestor {
  private readonly eventCoder: BorshEventCoder;

  constructor() {
    super();

    this.eventCoder = new BorshEventCoder(RelayDepositoryIdl as Idl);
  }

  public async getDepositoryDepositMessages(
    chainId: string,
    transactionId: string
  ): Promise<DepositoryDepositMessage[]> {
    const rpc = await httpRpc(chainId, "finalized");

    const transaction = await rpc.getParsedTransaction(transactionId, {
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction?.meta?.logMessages) {
      return [];
    }

    const chain = await getChain(chainId);
    const depository = chain.depository;
    if (!depository) {
      throw externalError("Chain has no depository configured");
    }

    return this._parseTransactionLogs(
      chainId,
      transactionId,
      transaction.meta.logMessages,
      depository
    );
  }

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

    // Check that transaction contains the order hash in the memo
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

  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

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
}
