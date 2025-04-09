import {
    PublicKey
} from "@solana/web3.js";
import { BorshEventCoder } from "@coral-xyz/anchor";
import {
    AttestationMessage,
    AttestationService,
    EscrowWithdrawalMessage,
    EscrowDepositMessage,
} from "./types";

import { getMessageId } from "./utils";
import { getChain } from "../../common/chains";
import { httpRpc } from "../../common/vm/svm/rpc";

// Anchor IDL
export type RelayEscrow = {
    "version": "0.1.0",
    "name": "relay_escrow",
    "instructions": [
        {
            "name": "initialize",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "owner",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "allocator",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": []
        },
        {
            "name": "setAllocator",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "owner",
                    "isMut": false,
                    "isSigner": true
                }
            ],
            "args": [
                {
                    "name": "newAllocator",
                    "type": "publicKey"
                }
            ]
        },
        {
            "name": "depositSol",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "depositor",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                },
                {
                    "name": "id",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "depositToken",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "depositor",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "depositorTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "associatedTokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                },
                {
                    "name": "id",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "executeTransfer",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "executor",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "recipient",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "vaultTokenAccount",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "recipientTokenAccount",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "usedRequest",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "associatedTokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "request",
                    "type": {
                        "defined": "TransferRequest"
                    }
                }
            ]
        }
    ],
    "accounts": [
        {
            "name": "relayEscrow",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "owner",
                        "type": "publicKey"
                    },
                    {
                        "name": "allocator",
                        "type": "publicKey"
                    },
                    {
                        "name": "vaultBump",
                        "type": "u8"
                    }
                ]
            }
        },
        {
            "name": "usedRequest",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "isUsed",
                        "type": "bool"
                    }
                ]
            }
        }
    ],
    "types": [
        {
            "name": "TransferRequest",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "recipient",
                        "type": "publicKey"
                    },
                    {
                        "name": "token",
                        "type": {
                            "option": "publicKey"
                        }
                    },
                    {
                        "name": "amount",
                        "type": "u64"
                    },
                    {
                        "name": "nonce",
                        "type": "u64"
                    },
                    {
                        "name": "expiration",
                        "type": "i64"
                    }
                ]
            }
        }
    ],
    "events": [
        {
            "name": "TransferExecutedEvent",
            "fields": [
                {
                    "name": "request",
                    "type": {
                        "defined": "TransferRequest"
                    },
                    "index": false
                },
                {
                    "name": "executor",
                    "type": "publicKey",
                    "index": false
                },
                {
                    "name": "id",
                    "type": "publicKey",
                    "index": false
                }
            ]
        },
        {
            "name": "DepositEvent",
            "fields": [
                {
                    "name": "depositor",
                    "type": "publicKey",
                    "index": false
                },
                {
                    "name": "token",
                    "type": {
                        "option": "publicKey"
                    },
                    "index": false
                },
                {
                    "name": "amount",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "id",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                }
            ]
        }
    ],
    "errors": [
        {
            "code": 6000,
            "name": "RequestAlreadyUsed",
            "msg": "Request has already been executed"
        },
        {
            "code": 6001,
            "name": "InvalidMint",
            "msg": "Invalid mint"
        },
        {
            "code": 6002,
            "name": "Unauthorized",
            "msg": "Unauthorized"
        },
        {
            "code": 6003,
            "name": "AllocatorSignerMismatch",
            "msg": "Allocator signer mismatch"
        },
        {
            "code": 6004,
            "name": "MessageMismatch",
            "msg": "Message mismatch"
        },
        {
            "code": 6005,
            "name": "MalformedEd25519Data",
            "msg": "Malformed Ed25519 data"
        },
        {
            "code": 6006,
            "name": "MissingSignature",
            "msg": "Missing signature"
        },
        {
            "code": 6007,
            "name": "SignatureExpired",
            "msg": "Signature expired"
        }
    ]
};

export const IDL: RelayEscrow = {
    "version": "0.1.0",
    "name": "relay_escrow",
    "instructions": [
        {
            "name": "initialize",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "owner",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "allocator",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": []
        },
        {
            "name": "setAllocator",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "owner",
                    "isMut": false,
                    "isSigner": true
                }
            ],
            "args": [
                {
                    "name": "newAllocator",
                    "type": "publicKey"
                }
            ]
        },
        {
            "name": "depositSol",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "depositor",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                },
                {
                    "name": "id",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "depositToken",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "depositor",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "depositorTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vaultTokenAccount",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "associatedTokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "amount",
                    "type": "u64"
                },
                {
                    "name": "id",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    }
                }
            ]
        },
        {
            "name": "executeTransfer",
            "accounts": [
                {
                    "name": "relayEscrow",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "executor",
                    "isMut": true,
                    "isSigner": true
                },
                {
                    "name": "recipient",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "vault",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "mint",
                    "isMut": false,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "vaultTokenAccount",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "recipientTokenAccount",
                    "isMut": true,
                    "isSigner": false,
                    "isOptional": true
                },
                {
                    "name": "usedRequest",
                    "isMut": true,
                    "isSigner": false
                },
                {
                    "name": "tokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "associatedTokenProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "systemProgram",
                    "isMut": false,
                    "isSigner": false
                },
                {
                    "name": "ixSysvar",
                    "isMut": false,
                    "isSigner": false
                }
            ],
            "args": [
                {
                    "name": "request",
                    "type": {
                        "defined": "TransferRequest"
                    }
                }
            ]
        }
    ],
    "accounts": [
        {
            "name": "relayEscrow",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "owner",
                        "type": "publicKey"
                    },
                    {
                        "name": "allocator",
                        "type": "publicKey"
                    },
                    {
                        "name": "vaultBump",
                        "type": "u8"
                    }
                ]
            }
        },
        {
            "name": "usedRequest",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "isUsed",
                        "type": "bool"
                    }
                ]
            }
        }
    ],
    "types": [
        {
            "name": "TransferRequest",
            "type": {
                "kind": "struct",
                "fields": [
                    {
                        "name": "recipient",
                        "type": "publicKey"
                    },
                    {
                        "name": "token",
                        "type": {
                            "option": "publicKey"
                        }
                    },
                    {
                        "name": "amount",
                        "type": "u64"
                    },
                    {
                        "name": "nonce",
                        "type": "u64"
                    },
                    {
                        "name": "expiration",
                        "type": "i64"
                    }
                ]
            }
        }
    ],
    "events": [
        {
            "name": "TransferExecutedEvent",
            "fields": [
                {
                    "name": "request",
                    "type": {
                        "defined": "TransferRequest"
                    },
                    "index": false
                },
                {
                    "name": "executor",
                    "type": "publicKey",
                    "index": false
                },
                {
                    "name": "id",
                    "type": "publicKey",
                    "index": false
                }
            ]
        },
        {
            "name": "DepositEvent",
            "fields": [
                {
                    "name": "depositor",
                    "type": "publicKey",
                    "index": false
                },
                {
                    "name": "token",
                    "type": {
                        "option": "publicKey"
                    },
                    "index": false
                },
                {
                    "name": "amount",
                    "type": "u64",
                    "index": false
                },
                {
                    "name": "id",
                    "type": {
                        "array": [
                            "u8",
                            32
                        ]
                    },
                    "index": false
                }
            ]
        }
    ],
    "errors": [
        {
            "code": 6000,
            "name": "RequestAlreadyUsed",
            "msg": "Request has already been executed"
        },
        {
            "code": 6001,
            "name": "InvalidMint",
            "msg": "Invalid mint"
        },
        {
            "code": 6002,
            "name": "Unauthorized",
            "msg": "Unauthorized"
        },
        {
            "code": 6003,
            "name": "AllocatorSignerMismatch",
            "msg": "Allocator signer mismatch"
        },
        {
            "code": 6004,
            "name": "MessageMismatch",
            "msg": "Message mismatch"
        },
        {
            "code": 6005,
            "name": "MalformedEd25519Data",
            "msg": "Malformed Ed25519 data"
        },
        {
            "code": 6006,
            "name": "MissingSignature",
            "msg": "Missing signature"
        },
        {
            "code": 6007,
            "name": "SignatureExpired",
            "msg": "Signature expired"
        }
    ]
};

interface DepositEventData {
    depositor: PublicKey;
    token: PublicKey | null;
    amount: bigint;
    id: number[];
}

interface TransferExecutedEventData {
    request: {
        recipient: PublicKey;
        token: PublicKey | null;
        amount: bigint;
        nonce: bigint;
        expiration: number;
    };
    executor: PublicKey;
    id: PublicKey;
}

export class SolanaAttestationService implements AttestationService {
    private readonly eventCoder: BorshEventCoder;

    constructor() {
        this.eventCoder = new BorshEventCoder(IDL);
    }

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
        const transaction = await connection.getParsedTransaction(transactionId, {
            maxSupportedTransactionVersion: 0,
        });

        if (!transaction?.meta?.logMessages) {
            return [];
        }

        return this.parseTransactionLogs(
            chainId,
            transactionId,
            transaction.meta.logMessages,
            chain.escrow
        );
    }

    private parseTransactionLogs(
        chainId: number,
        transactionId: string,
        logs: string[],
        escrowAddress: string
    ): AttestationMessage[] {
        const messages: AttestationMessage[] = [];
        let messageIndex = 0;

        for (const log of logs) {
            if (!log.startsWith("Program data: ")) {
                continue;
            }

            try {
                const event = this.eventCoder.decode(log.slice("Program data: ".length));
                if (!event) continue;

                const message = this.createMessageFromEvent(
                    event,
                    chainId,
                    transactionId,
                    escrowAddress,
                    messageIndex++
                );

                if (message) {
                    messages.push(message);
                }
            } catch (e) {
                console.error("Failed to decode event:", {
                    error: e,
                    log,
                    transactionId
                });
            }
        }

        return messages;
    }

    private createMessageFromEvent(
        event: any,
        chainId: number,
        transactionId: string,
        escrowAddress: string,
        messageIndex: number
    ): AttestationMessage | null {
        const messageId = getMessageId(
            chainId,
            transactionId,
            messageIndex.toString()
        );

        const input = {
            chainId,
            transactionId
        };

        switch (event.name) {
            case "DepositEvent":
                return this.createDepositMessage(
                    event.data as DepositEventData,
                    messageId,
                    input,
                    escrowAddress
                );
            case "TransferExecutedEvent":
                return this.createWithdrawalMessage(
                    event.data as TransferExecutedEventData,
                    messageId,
                    input,
                    escrowAddress
                );
            default:
                return null;
        }
    }

    private createDepositMessage(
        data: DepositEventData,
        messageId: string,
        input: { chainId: number; transactionId: string },
        escrowAddress: string
    ): EscrowDepositMessage {
        return {
            kind: "escrow-deposit",
            messageId,
            input,
            output: {
                escrow: escrowAddress,
                depositor: data.depositor.toBase58(),
                currency: data.token ? 
                    data.token.toBase58() : 
                    "11111111111111111111111111111111",
                amount: data.amount.toString(),
                id: Buffer.from(data.id).toString('hex')
            }
        };
    }

    private createWithdrawalMessage(
        data: TransferExecutedEventData,
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
                currency: data.request.token ?
                    data.request.token.toBase58() :
                    "11111111111111111111111111111111",
                amount: data.request.amount.toString(),
                id: data.id.toBase58()
            }
        };
    }
}