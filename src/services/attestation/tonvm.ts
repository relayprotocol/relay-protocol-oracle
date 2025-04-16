
import {
    AttestationMessage,
    AttestationService,
    EscrowWithdrawalMessage,
    EscrowDepositMessage,
} from "./types";

import { getMessageId } from "./utils";
import { getChain } from "../../common/chains";
import { httpRpc } from "../../common/vm/tonvm/rpc";
import { RelayEscrow, DepositEvent, WithdrawEvent, ADDRESS_NONE } from "./wrappers/RelayEscrow";
import { Address, Message } from "@ton/core";
import { TonClient } from "@ton/ton";

export class SuiAttestationService implements AttestationService {

    public async attestEscrowDeposits(
        chainId: number,
        transactionId: string
    ): Promise<AttestationMessage[]> {
        return this.getEscrowMessages(chainId, transactionId).then((messages) =>
            messages.filter((m) => m.kind === "escrow-deposit")
        );
    }

    public async attestEscrowWithdrawals(
        chainId: number,
        transactionId: string
    ): Promise<AttestationMessage[]> {
        return this.getEscrowMessages(chainId, transactionId).then((messages) =>
            messages.filter((m) => m.kind === "escrow-withdrawal")
        );
    }

    private async getEscrowMessages(
        chainId: number,
        transactionId: string
    ): Promise<AttestationMessage[]> {
        const chain = await getChain(chainId);
        const connection = await httpRpc(chainId);
        const [
            address,
            lt,
            hash
        ] = transactionId.split("::")
        const transaction = await connection.getTransaction(
            Address.parse(address),
            lt,
            hash
        );

        if (!transaction?.outMessages) {
            return [];
        }

        return await this.parseTransactionLogs(
            chainId,
            transactionId,
            transaction.outMessages.values(),
            chain.escrow,
            connection
        );
    }

    private async parseTransactionLogs(
        chainId: number,
        transactionId: string,
        events: Message[],
        escrowAddress: string,
        connection: TonClient
    ): Promise<AttestationMessage[]> {
        const messages: AttestationMessage[] = [];
        let messageIndex = 0;

        for (const event of events) {
            const message = await this.createMessageFromEvent(
                event,
                chainId,
                transactionId,
                escrowAddress,
                messageIndex++,
                connection
            );

            if (message) {
                messages.push(message);
            }
        }

        return messages;
    }

    private async createMessageFromEvent(
        event: Message,
        chainId: number,
        transactionId: string,
        escrowAddress: string,
        messageIndex: number,
        connection: TonClient
    ): Promise<AttestationMessage | null> {
        const messageId = getMessageId(
            chainId,
            transactionId,
            messageIndex.toString()
        );

        const input = {
            chainId,
            transactionId
        };

        const message = await RelayEscrow.parseOutMessage(event, connection.provider(Address.parse(escrowAddress)));

        if (message?.name === "Deposit") {
            return this.createDepositMessage(
                message,
                messageId,
                input,
                escrowAddress
            );

        } else if (message?.name === "Withdraw") {
            return this.createWithdrawalMessage(
                message,
                messageId,
                input,
                escrowAddress
            );
        } else {
            return null;
        }
    }

    private async createDepositMessage(
        event: DepositEvent,
        messageId: string,
        input: { chainId: number; transactionId: string },
        escrowAddress: string
    ): Promise<EscrowDepositMessage> {
        return {
            kind: "escrow-deposit",
            messageId,
            input,
            output: {
                escrow: escrowAddress,
                depositor: event.data.depositor,
                currency: event.data.assetType === 0 ? ADDRESS_NONE.toString() : event.data.currency,
                amount: event.data.amount.toString(),
                id: event.data.depositId.toString()
            }
        };
    }

    private createWithdrawalMessage(
        event: WithdrawEvent,
        messageId: string,
        input: { chainId: number; transactionId: string },
        escrowAddress: string
    ): EscrowWithdrawalMessage {
        return {
            kind: "escrow-withdrawal",
            messageId,
            input,
            output: {
                escrow: escrowAddress,
                currency: event.data.currency,
                amount: event.data.amount.toString(),
                id: event.data.msgHash.toString()
            }
        };
    }
}