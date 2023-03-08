import {
  getL1Network,
  getL2Network,
  L1Network,
  L1ToL2MessageReader,
  L1ToL2MessageStatus,
  L1TransactionReceipt,
  L2ToL1MessageStatus,
  L2TransactionReceipt,
} from '@arbitrum/sdk';
import { constants } from 'ethers';
import { hexDataSlice } from 'ethers/lib/utils';
import { BigNumber } from '@ethersproject/bignumber';
import {
  JsonRpcProvider,
  StaticJsonRpcProvider,
} from '@ethersproject/providers';

import { L1ToL2MessageWaitResult } from '@arbitrum/sdk/dist/lib/message/L1ToL2Message';

import {
  AlertLevel,
  EthDepositMessageWithNetwork,
  L1ToL2MessageReaderClassicWithNetwork,
  L1ToL2MessageReaderWithNetwork,
  L1ToL2MessagesAndDepositMessages,
  L2ToL1MessageData,
  L2ToL1MessageSearchResult,
  L2TxnStatus,
  MessageStatusDisplay,
  ReceiptRes,
  ReceiptState,
} from './types';

if (!process.env.NEXT_PUBLIC_INFURA_KEY)
  throw new Error('No NEXT_PUBLIC_INFURA_KEY set');

const supportedL1Networks = {
  1: `https://mainnet.infura.io/v3/${process.env.NEXT_PUBLIC_INFURA_KEY}`,
  5: `https://goerli.infura.io/v3/${process.env.NEXT_PUBLIC_INFURA_KEY}`,
};

const supportedL2Networks = {
  42161: `https://arb1.arbitrum.io/rpc`,
  421613: `https://goerli-rollup.arbitrum.io/rpc`,
  42170: `https://nova.arbitrum.io/rpc`,
};

export const getL2ToL1Messages = async (
  txHash: string,
): Promise<L2ToL1MessageSearchResult> => {
  for (const [chainID, rpcURL] of Object.entries(supportedL2Networks)) {
    const l2Network = await getL2Network(+chainID);
    const l2Provider = await new JsonRpcProvider(rpcURL);

    // TODO
    const l1ChainID = l2Network.partnerChainID as 1 | 5;
    const l1Network = await getL1Network(l1ChainID);
    const l1Provider = await new JsonRpcProvider(
      supportedL1Networks[l1ChainID],
    );
    const currentL1Block = BigNumber.from(await l1Provider.getBlockNumber());
    const receipt = await l2Provider.getTransactionReceipt(txHash);
    if (receipt) {
      if (receipt.status === 0) {
        // l1 tx failed, terminal
        return {
          l2TxnStatus: L2TxnStatus.FAILURE,
          l2ToL1Messages: [],
          l2TxHash: txHash,
        };
      }
      const l2Receipt = new L2TransactionReceipt(receipt);
      const l2ToL1Messages = await l2Receipt.getL2ToL1Messages(l1Provider);
      const l2MessagesData: L2ToL1MessageData[] = [];
      for (const l2ToL1Message of l2ToL1Messages) {
        try {
          const status = await l2ToL1Message.status(l2Provider);
          const deadlineBlock =
            status !== L2ToL1MessageStatus.CONFIRMED &&
            status !== L2ToL1MessageStatus.EXECUTED
              ? await l2ToL1Message.getFirstExecutableBlock(l2Provider)
              : null;

          l2MessagesData.push({
            status,
            l2ToL1Message,
            confirmationInfo: deadlineBlock
              ? {
                  deadlineBlock,
                  etaSeconds: deadlineBlock
                    .sub(currentL1Block)
                    .mul(15)
                    .toNumber(),
                }
              : null,
            l1Network,
            l2Network,
            l2Provider,
            createdAtL2BlockNumber: l2Receipt.blockNumber,
          });
        } catch (e) {
          const expectedError = "batch doesn't exist";
          const err = e as Error & { error: Error };
          const actualError =
            err && (err.message || (err.error && err.error.message));
          if (actualError.includes(expectedError)) {
            console.warn('batch doesnt exist');

            l2MessagesData.push({
              status: L2ToL1MessageStatus.UNCONFIRMED,
              l2ToL1Message,
              confirmationInfo: null,
              l1Network,
              l2Network,
              l2Provider,
              createdAtL2BlockNumber: l2Receipt.blockNumber,
            });
          } else {
            throw e;
          }
        }
      }
      return {
        l2TxnStatus: L2TxnStatus.SUCCESS,
        l2ToL1Messages: l2MessagesData,
        l2TxHash: txHash,
      };
    }
  }
  return {
    l2TxnStatus: L2TxnStatus.NOT_FOUND,
    l2ToL1Messages: [],
    l2TxHash: txHash,
  };
};

export const getL1ToL2MessagesAndDepositMessages = async (
  l1TxnReceipt: L1TransactionReceipt,
  l1Network: L1Network,
): Promise<L1ToL2MessagesAndDepositMessages> => {
  let allL1ToL2Messages: L1ToL2MessageReaderWithNetwork[] = [];
  let allL1ToL2MessagesClassic: L1ToL2MessageReaderClassicWithNetwork[] = [];
  let allDepositMessages: EthDepositMessageWithNetwork[] = [];

  for (const l2ChainID of Array.from(new Set(l1Network.partnerChainIDs))) {
    // TODO: error handle
    const l2Network = await getL2Network(l2ChainID);

    // Check if any l1ToL2 msg is sent to the inbox of this l2Network
    const logFromL2Inbox = l1TxnReceipt.logs.filter((log) => {
      return (
        log.address.toLowerCase() === l2Network.ethBridge.inbox.toLowerCase()
      );
    });
    if (logFromL2Inbox.length === 0) continue;

    let l2RpcURL;
    switch (l2ChainID) {
      case 42161:
        l2RpcURL = 'https://arb1.arbitrum.io/rpc';
        break;
      case 42170:
        l2RpcURL = 'https://nova.arbitrum.io/rpc';
        break;
      case 421613:
        l2RpcURL = 'https://goerli-rollup.arbitrum.io/rpc';
        break;
      default:
        throw new Error(
          'Unknown L2 chain id. This chain is not supported by dashboard',
        );
    }
    const l2Provider = new StaticJsonRpcProvider(l2RpcURL);
    const isClassic = await l1TxnReceipt.isClassic(l2Provider);

    if (isClassic) {
      const messages = (
        await l1TxnReceipt.getL1ToL2MessagesClassic(l2Provider)
      ).map((l1ToL2Message) => {
        return Object.assign(l1ToL2Message, { l2Network });
      });
      allL1ToL2MessagesClassic = allL1ToL2MessagesClassic.concat(messages);
    } else {
      const messages = (await l1TxnReceipt.getL1ToL2Messages(l2Provider)).map(
        (l1ToL2Message) => {
          return Object.assign(l1ToL2Message, { l2Network });
        },
      );

      const depositMessagesWithNetwork: EthDepositMessageWithNetwork[] = (
        await l1TxnReceipt.getEthDeposits(l2Provider)
      ).map((depositMessage) => {
        return Object.assign(depositMessage, { l2Network });
      });

      allL1ToL2Messages = allL1ToL2Messages.concat(messages);
      allDepositMessages = allDepositMessages.concat(
        depositMessagesWithNetwork,
      );
    }
  }

  const allMessages: L1ToL2MessagesAndDepositMessages = {
    retryables: allL1ToL2Messages,
    retryablesClassic: allL1ToL2MessagesClassic,
    deposits: allDepositMessages,
  };
  return allMessages;
};

export const depositMessageStatusDisplay = async (
  ethDepositMessage: EthDepositMessageWithNetwork,
): Promise<MessageStatusDisplay> => {
  const { l2Network } = ethDepositMessage;
  const { explorerUrl } = l2Network;
  const depositTxReceipt = await ethDepositMessage.wait();
  const l2TxHash = ethDepositMessage.l2DepositTxHash;

  // naming is hard
  const stuffTheyAllHave = {
    l1ToL2Message: undefined,
    explorerUrl,
    l2Network,
    ethDepositMessage,
    l2TxHash,
  };
  if (depositTxReceipt?.status === 1) {
    return {
      text: 'Success! 🎉 Your Eth deposit has completed',
      alertLevel: AlertLevel.GREEN,
      showRedeemButton: false,
      ...stuffTheyAllHave,
    };
  } else {
    return {
      text: 'Something failed in this tracker, you can try to check your account on l2',
      alertLevel: AlertLevel.RED,
      showRedeemButton: false,
      ...stuffTheyAllHave,
    };
  }
};

export const l1ToL2MessageToStatusDisplay = async (
  l1ToL2Message:
    | L1ToL2MessageReaderWithNetwork
    | L1ToL2MessageReaderClassicWithNetwork,
  isClassic: boolean,
): Promise<MessageStatusDisplay> => {
  const { l2Network } = l1ToL2Message;
  const { explorerUrl } = l2Network;

  let messageStatus: L1ToL2MessageWaitResult | { status: L1ToL2MessageStatus };
  try {
    if (isClassic) {
      messageStatus = {
        status: await (
          l1ToL2Message as L1ToL2MessageReaderWithNetwork
        ).status(),
      };
    } else {
      messageStatus = await (
        l1ToL2Message as L1ToL2MessageReader
      ).waitForStatus(undefined, 1);
    }
  } catch (e) {
    // catch timeout if not immediately found
    messageStatus = { status: L1ToL2MessageStatus.NOT_YET_CREATED };
  }

  let l2TxHash = 'null';
  if (
    messageStatus.status === L1ToL2MessageStatus.REDEEMED &&
    'l2TxReceipt' in messageStatus
  ) {
    l2TxHash = messageStatus.l2TxReceipt.transactionHash;
  }

  // naming is hard
  const stuffTheyAllHave = {
    ethDepositMessage: undefined,
    explorerUrl,
    l2Network,
    l1ToL2Message,
    l2TxHash,
  };
  switch (messageStatus.status) {
    case L1ToL2MessageStatus.CREATION_FAILED:
      return {
        text: 'L2 message creation reverted; perhaps provided maxSubmissionCost was too low?',
        alertLevel: AlertLevel.RED,
        showRedeemButton: false,
        ...stuffTheyAllHave,
      };
    case L1ToL2MessageStatus.EXPIRED: {
      const looksLikeEthDeposit = await looksLikeCallToInboxethDeposit(
        l1ToL2Message,
      );
      if (looksLikeEthDeposit) {
        return {
          text: 'Success! 🎉 Your Eth deposit has completed',
          alertLevel: AlertLevel.GREEN,
          showRedeemButton: false,
          ...stuffTheyAllHave,
        };
      }
      return {
        text: 'Retryable ticket expired.',
        alertLevel: AlertLevel.RED,
        showRedeemButton: false,
        ...stuffTheyAllHave,
      };
    }
    case L1ToL2MessageStatus.NOT_YET_CREATED: {
      return {
        text: 'L1 to L2 message initiated from L1, but not yet created — check again in a few minutes!',
        alertLevel: AlertLevel.YELLOW,
        showRedeemButton: false,
        ...stuffTheyAllHave,
      };
    }
    case L1ToL2MessageStatus.REDEEMED: {
      return {
        text: 'Success! 🎉 Your retryable was executed.',
        alertLevel: AlertLevel.GREEN,
        showRedeemButton: false,
        ...stuffTheyAllHave,
      };
    }
    case L1ToL2MessageStatus.FUNDS_DEPOSITED_ON_L2: {
      const looksLikeEthDeposit = await looksLikeCallToInboxethDeposit(
        l1ToL2Message,
      );
      if (looksLikeEthDeposit) {
        return {
          text: 'Success! 🎉 Your Eth deposit has completed',
          alertLevel: AlertLevel.GREEN,
          showRedeemButton: false,
          ...stuffTheyAllHave,
        };
      }
      const text =
        // we do not know why auto redeem failed in nitro
        'Auto-redeem failed; you can redeem it now:';
      return {
        text,
        alertLevel: AlertLevel.YELLOW,
        showRedeemButton: true,
        ...stuffTheyAllHave,
      };
    }

    default:
      throw new Error('Uncaught L1ToL2MessageStatus type in switch statement');
  }
};

export const looksLikeCallToInboxethDeposit = async (
  l1ToL2Message:
    | L1ToL2MessageReaderWithNetwork
    | L1ToL2MessageReaderClassicWithNetwork,
) => {
  const txData = (
    await l1ToL2Message.l2Provider.getTransaction(
      l1ToL2Message.retryableCreationId,
    )
  ).data;
  // check that calldataSize param is zero (8th 32-byte param, offset by 4 bytes for message ID):
  return hexDataSlice(txData, 4 + 8 * 32, 4 + 9 * 32) === constants.HashZero;
};

export const receiptStateToDisplayableResult = (
  l1ReceiptState: ReceiptState,
): {
  text: string;
  alertLevel: AlertLevel;
} => {
  switch (l1ReceiptState) {
    case ReceiptState.EMPTY:
      return {
        text: '',
        alertLevel: AlertLevel.NONE,
      };
    case ReceiptState.LOADING:
      return {
        text: 'Loading...',
        alertLevel: AlertLevel.NONE,
      };
    case ReceiptState.INVALID_INPUT_LENGTH:
      return {
        text: 'Error: invalid transaction hash',
        alertLevel: AlertLevel.RED,
      };
    case ReceiptState.NOT_FOUND:
      return {
        text: 'L1 transaction not found',
        alertLevel: AlertLevel.YELLOW,
      };
    case ReceiptState.L1_FAILED:
      return {
        text: 'Error: L1 transaction reverted',
        alertLevel: AlertLevel.RED,
      };
    case ReceiptState.L2_FAILED:
      return {
        text: 'Error: L2 transaction reverted',
        alertLevel: AlertLevel.RED,
      };
    case ReceiptState.NO_L1_L2_MESSAGES:
      return {
        text: 'No L1-to-L2 messages created by provided L1 transaction',
        alertLevel: AlertLevel.YELLOW,
      };
    case ReceiptState.MESSAGES_FOUND:
      return {
        text: 'Cross chain messages found',
        alertLevel: AlertLevel.GREEN,
      };
    case ReceiptState.NO_L2_L1_MESSAGES: {
      return {
        text: 'No L1-to-L2 messages created by provided L1 transaction',
        alertLevel: AlertLevel.YELLOW,
      };
    }
  }
};

export const getL1TxnReceipt = async (
  txnHash: string,
): Promise<ReceiptRes | undefined> => {
  for (const [chainID, rpcURL] of Object.entries(supportedL1Networks)) {
    const l1Network = await getL1Network(+chainID);
    const l1Provider = await new StaticJsonRpcProvider(rpcURL);

    const rec = await l1Provider.getTransactionReceipt(txnHash);
    if (rec) {
      return {
        l1TxnReceipt: new L1TransactionReceipt(rec),
        l1Network,
        l1Provider,
      };
    }
  }
};

export const getRetryableIdOrDepositHash = (message: MessageStatusDisplay) => {
  if (message.l1ToL2Message !== undefined) {
    return message.l1ToL2Message.retryableCreationId;
  }
  return message.ethDepositMessage.l2DepositTxHash;
};

function isValidTxHash(txHash: string | undefined): txHash is string {
  if (!txHash) {
    return false;
  }
  return /^0x([A-Fa-f0-9]{64})$/.test(txHash);
}

export { isValidTxHash };
