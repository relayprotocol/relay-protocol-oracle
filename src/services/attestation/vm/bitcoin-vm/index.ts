import {
  decodeWithdrawal,
  DepositoryDepositMessage,
  DepositoryWithdrawalMessage,
  DepositoryWithdrawalStatus,
  getDecodedWithdrawalId,
} from "@reservoir0x/relay-protocol-sdk";
import { externalError, internalError } from "../../../../common/error";
import { httpRpc } from "../../../../common/vm/bitcoin-vm/rpc";
import { VmAttestor } from "../../vm/types";

export class BitcoinVmAttestor extends VmAttestor {

  public async getDepositoryDepositMessages(
    _chainId: string,
    _transactionId: string
  ): Promise<DepositoryDepositMessage[]> {
    throw internalError("Not implemented (getDepositoryDepositMessages)");
  }

  public async getDepositoryWithdrawalMessage(
    _chainId: string,
    _withdrawal: string
  ): Promise<DepositoryWithdrawalMessage> {
    throw internalError("Not implemented (getDepositoryDepositMessages)");
  }

  public async getSolverPaidAmount(
    _chainId: string,
    _transactionId: string,
    _payment: {
      currency: string;
      recipient: string;
      orderHash: string;
      extraData: string;
      deadline: number;
    }
  ): Promise<bigint> {
    throw internalError("Not implemented");
  }

  public verifySolverCalls(
    _chainId: string,
    _transactionId: string,
    _calls: string[],
    _extraData: string
  ): Promise<boolean> {
    throw internalError("Not implemented");
  }

}
