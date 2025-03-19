import { Type } from "@fastify/type-provider-typebox";

import {
  Endpoint,
  FastifyReplyTypeBox,
  FastifyRequestTypeBox,
  buildContinuation,
  splitContinuation,
} from "../utils";
import { db } from "../../common/db";

const Schema = {
  querystring: Type.Object({
    limit: Type.Number({
      maximum: 20,
      default: 20,
      description: "The maximum number of results to return",
    }),
    continuation: Type.Optional(
      Type.String({
        description:
          "Continuation to be used for iterating over multiple pages of results",
      })
    ),
    sortBy: Type.Union([Type.Literal("createdAt"), Type.Literal("updatedAt")], {
      description: "Sorting field",
      default: "createdAt",
    }),
    sortDirection: Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
      description: "Sorting direction",
      default: "desc",
    }),
  }),
  response: {
    200: Type.Object({
      entries: Type.Array(
        Type.Object(
          {
            chainId: Type.Number({
              description: "The chain id of the transaction",
            }),
            transactionId: Type.String({
              description: "The transaction id",
            }),
            entryId: Type.String({
              description: "The id of the entry within the transaction",
            }),
            data: Type.Union([
              Type.Object({
                type: Type.Literal("deposit"),
                data: Type.Object({
                  depositorAddress: Type.String({
                    description: "The depositor",
                  }),
                  currencyAddress: Type.String({
                    description: "The deposit currency",
                  }),
                  amount: Type.String({
                    description: "The deposit amount",
                  }),
                  depositId: Type.Optional(
                    Type.String({
                      description: "The id associated to the deposit",
                    })
                  ),
                }),
              }),
              Type.Object({
                type: Type.Literal("withdrawal"),
                data: Type.Object({
                  currencyAddress: Type.String({
                    description: "The withdrawal currency",
                  }),
                  amount: Type.String({
                    description: "The withdrawal amount",
                  }),
                  withdrawalId: Type.String({
                    description: "The id associated to the withdrawal",
                  }),
                }),
              }),
            ]),
            createdAt: Type.String({
              description: "The creation time of the transaction entry",
            }),
            updatedAt: Type.String({
              description: "The update time of the transaction entry",
            }),
          },
          {
            description: "A list of finalized transaction entries",
          }
        )
      ),
      continuation: Type.Optional(
        Type.String({
          description:
            "Continuation to be used for getting the next page of results",
        })
      ),
    }),
  },
};

export default {
  method: "GET",
  url: "/transactions/entries/v1",
  schema: Schema,
  handler: async (
    req: FastifyRequestTypeBox<typeof Schema>,
    reply: FastifyReplyTypeBox<typeof Schema>
  ) => {
    const query = req.query;

    const sortBy = query.sortBy === "createdAt" ? "created_at" : "updated_at";
    const sortDirection = query.sortDirection === "asc" ? "ASC" : "DESC";
    const limit = query.limit;

    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (query.continuation) {
      const [
        sortByContinuation,
        transactionIdContinuation,
        entryIdContinuation,
      ] = splitContinuation(query.continuation);

      conditions.push(`
        (
          transaction_entries.${sortBy},
          transaction_entries.transaction_id,
          transaction_entries.entry_id
        ) ${sortDirection === "ASC" ? ">" : "<"} (
          $/sortByContinuation/,
          $/transactionIdContinuation/,
          $/entryIdContinuation/
        )
      `);
      params.sortByContinuation = new Date(sortByContinuation);
      params.transactionIdContinuation = transactionIdContinuation;
      params.entryIdContinuation = entryIdContinuation;
    }

    const results = await db.manyOrNone(
      `
        SELECT
          transaction_entries.chain_id,
          transaction_entries.transaction_id,
          transaction_entries.entry_id,
          transaction_entries.data,
          transaction_entries.created_at,
          transaction_entries.updated_at
        FROM transaction_entries
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY
          transaction_entries.${sortBy} ${sortDirection},
          transaction_entries.transaction_id ${sortDirection},
          transaction_entries.entry_id ${sortDirection}
        LIMIT ${limit}
      `,
      params
    );

    let continuation: string | undefined;
    if (results.length >= limit) {
      const lastResult = results[results.length - 1];
      console.log(lastResult.created_at);
      continuation = buildContinuation(
        (
          (sortBy === "created_at"
            ? lastResult.created_at
            : lastResult.updated_at) as Date
        ).toISOString(),
        lastResult.transaction_id,
        lastResult.entry_id
      );
    }

    return reply.send({
      entries: results.map((result) => ({
        chainId: result.chain_id,
        transactionId: result.transaction_id,
        entryId: result.entry_id,
        data: result.data,
        createdAt: new Date(result.created_at).toISOString(),
        updatedAt: new Date(result.updated_at).toISOString(),
      })),
      continuation,
    });
  },
} as Endpoint;
