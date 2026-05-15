import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  ErrorResponses,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  getPeerResponses,
} from "../../utils";
import { signDepositAddressTriggerMessage } from "../../../common/signer";
import { config } from "../../../config";
import { AttestationService } from "../../../services/attestation";

const Schema = {
  body: Type.Object({
    input: Type.Object(
      {
        vmType: Type.String({
          description: "Identifier of the source virtual machine",
        }),
        chainId: Type.String({
          description: "Identifier of the source chain",
        }),
        currency: Type.String({
          description:
            "Opaque, VM-specific encoding of the currency being deposited",
        }),
        amount: Type.String({
          description:
            "Amount of input currency being deposited, in its smallest unit",
        }),
      },
      { description: "Description of the funds being deposited" },
    ),
    derivationFields: Type.Object(
      {
        inputVmType: Type.String({
          description: "Identifier of the source virtual machine",
        }),
        outputVmType: Type.String({
          description: "Identifier of the destination virtual machine",
        }),
        outputChainId: Type.String({
          description: "Identifier of the destination chain",
        }),
        outputCurrency: Type.String({
          description:
            "Opaque, VM-specific encoding of the destination currency",
        }),
        outputRecipient: Type.String({
          description:
            "Opaque, VM-specific encoding of the recipient address on the destination chain",
        }),
        solver: Type.String({
          description: "Address of the solver that released the order",
        }),
        pricingOracle: Type.String({
          description:
            "Address of the pricing oracle consulted by the trigger transaction",
        }),
        depositor: Type.String({
          description:
            "Opaque, VM-specific encoding of the depositor on the source chain",
        }),
        refundRecipient: Type.String({
          description:
            "Opaque, VM-specific encoding of the refund recipient on the source chain",
        }),
        priceImpactBps: Type.String({
          description: "Maximum allowed price impact, in basis points",
        }),
      },
      {
        description: "Fields that deterministically derive the deposit address",
      },
    ),
    orderId: Type.String({
      description: "The id of the order associated with the trigger",
    }),
    nonce: Type.String({
      description:
        "Caller-supplied nonce that disambiguates otherwise-identical triggers",
    }),
    currencies: Type.Array(
      Type.Object({
        chainId: Type.String({
          description: "Identifier of the chain the currency lives on",
        }),
        currency: Type.String({
          description: "Opaque, VM-specific encoding of the currency",
        }),
      }),
      {
        description:
          "Currencies whose USD prices were captured in the trigger hash",
      },
    ),
    prices: Type.Array(
      Type.Object({
        usdPrice: Type.String({
          description:
            "USD price of one whole unit of the currency, scaled by 10 ** usdPriceDecimals",
        }),
        usdPriceDecimals: Type.Integer({
          minimum: 0,
          maximum: 255,
          description: "Fixed-point precision of usdPrice",
        }),
        currencyDecimals: Type.Integer({
          minimum: 0,
          maximum: 255,
          description: "Number of decimals the currency itself uses",
        }),
        expiration: Type.String({
          description:
            "Unix timestamp after which this price should no longer be used",
        }),
      }),
      {
        description:
          "USD prices captured for currencies, in the same order as currencies",
      },
    ),
    extraData: Type.String({
      description:
        "Opaque data forwarded to the pricing oracle and bound into the trigger hash",
    }),
    requestPeerSignatures: Type.Optional(
      Type.Boolean({
        description:
          "Whether to request signatures from any configured oracle peers",
      }),
    ),
  }),
  response: {
    ...ErrorResponses,
    200: Type.Object({
      trigger: Type.Object({
        chainId: Type.String({
          description: "The Hub EVM chain id",
        }),
        depositAddressManager: Type.String({
          description:
            "The deposit-address manager smart contract address on the Hub",
        }),
        inputDepository: Type.String({
          description:
            "Opaque, VM-specific encoding of the depository on the input chain",
        }),
        triggerHash: Type.String({
          description: "The EIP-712 deposit address trigger hash",
        }),
        signatures: Type.Array(
          Type.Object({
            oracleSigner: Type.String({
              description: "The address of the oracle signer",
            }),
            signature: Type.String({
              description: "The trigger hash attestation signature",
            }),
          }),
          {
            minItems: 1,
            description: "Oracle signatures attesting the trigger hash",
          },
        ),
      }),
    }),
  },
};

type DepositAddressTriggerMessage = {
  chainId: string;
  depositAddressManager: string;
  inputDepository: string;
  triggerHash: string;
};

const areTriggersEqual = (
  msg1?: DepositAddressTriggerMessage,
  msg2?: DepositAddressTriggerMessage,
) => {
  if (!msg1 || !msg2) {
    return false;
  }

  return (
    msg1.chainId === msg2.chainId &&
    msg1.depositAddressManager.toLowerCase() ===
      msg2.depositAddressManager.toLowerCase() &&
    msg1.inputDepository === msg2.inputDepository &&
    msg1.triggerHash === msg2.triggerHash
  );
};

export default {
  method: "POST",
  url: "/attestations/deposit-address-triggers/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>,
  ) => {
    const attestationService = new AttestationService();
    const trigger = await attestationService.attestDepositAddressTrigger(
      req.body,
    );

    const peerSignatures =
      req.body.requestPeerSignatures && config.peers
        ? await getPeerResponses({
            endpointPath: req.originalUrl,
            requestBody: req.body,
            requestApiKey: req.headers["x-api-key"],
            validateAndExtractResponse: (peerData: any) => {
              if (areTriggersEqual(peerData.trigger, trigger)) {
                return peerData.trigger.signatures;
              }

              return [];
            },
          })
        : [];

    return reply.send({
      trigger: {
        chainId: trigger.chainId,
        depositAddressManager: trigger.depositAddressManager,
        inputDepository: trigger.inputDepository,
        triggerHash: trigger.triggerHash,
        signatures: [
          await signDepositAddressTriggerMessage({
            chainId: trigger.chainId,
            depositAddressManager: trigger.depositAddressManager,
            inputDepository: trigger.inputDepository,
            triggerHash: trigger.triggerHash,
          }),
          ...peerSignatures,
        ],
      },
    });
  },
} as Endpoint;
