import { Connection } from "@solana/web3.js";
import axios from "axios";
import { MagicEdenConfig } from "config";
import logger from "lib/logger";
import { NFTList, SaleMethod } from "lib/marketplaces";
import MagicEden from "lib/marketplaces/magicEden";
import { NotificationType, Notifier } from "lib/notifier";
import { fetchNFTData } from "lib/solana/NFTData";
import { Worker } from "./types";

export interface CollectionActivity {
  signature: string;
  type: string;
  source: string;
  tokenMint: string;
  collection: string;
  slot: number;
  blockTime: number;
  buyer: string;
  buyerReferral: string;
  seller?: any;
  sellerReferral: string;
  price: number;
}

function newNotificationsTracker(limit: number = 50) {
  let notifiedTxs: string[] = [];

  return {
    alreadyNotified(tx: string) {
      return notifiedTxs.includes(tx);
    },
    trackNotifiedTx(tx: string) {
      notifiedTxs = [tx, ...notifiedTxs];
      if (notifiedTxs.length > limit) {
        notifiedTxs.pop();
      }
    },
  };
}

export default function newWorker(
  notifier: Notifier,
  web3Conn: Connection,
  config: MagicEdenConfig
): Worker {
  const timestamp = Date.now();
  let notifyAfter = new Date(timestamp);

  /**
   * Keep track of the latest notifications, so we don't notify them again
   */
  const latestNotifications = newNotificationsTracker();

  return {
    async execute() {
      let activities: CollectionActivity[] = [];
      try {
        // Reference: https://api.magiceden.dev/#95fed531-fd1f-4cbb-8137-30e0f2294cd7
        const res = await axios.get(
          `${config.url}/collections/${config.collection}/activities?offset=0&limit=100`
        );
        activities = res.data as CollectionActivity[];
      } catch (e) {
        logger.error(e);
        return;
      }

      const sortByEarliest = activities.sort(
        (a: CollectionActivity, b: CollectionActivity) => {
          return a.blockTime - b.blockTime;
        }
      );

      for (let i = 0; i < sortByEarliest.length; i++) {
        const activity = sortByEarliest[i];
        if (activity.type !== "list") {
          continue;
        }

        const nftData = await fetchNFTData(web3Conn, activity.tokenMint);
        if (!nftData) {
          return;
        }

        if (
          config.degensToWatch &&
          config.degensToWatch?.length > 0 &&
          config.degensToWatch?.includes(nftData.name.split("#")[1]) === false
        ) {
          return;
        }

        const nftList: NFTList = {
          transaction: activity.signature,
          soldAt: new Date((activity.blockTime || 0) * 1000),
          seller: activity.seller,
          token: activity.tokenMint,
          method: SaleMethod.Direct,
          marketplace: MagicEden,
          transfers: [],
          nftData,
          getPriceInLamport() {
            return activity.price / 1000000;
          },
          getPriceInSOL() {
            return activity.price;
          },
        };

        if (notifyAfter > nftList.soldAt) {
          return;
        }

        // Don't notify if transaction was previously notified.
        if (latestNotifications.alreadyNotified(nftList.transaction)) {
          logger.warn(`Duplicate tx ignored: ${nftList.transaction}`);
          return;
        }

        await notifier.notify(NotificationType.List, nftList);

        latestNotifications.trackNotifiedTx(nftList.transaction);
        notifyAfter = nftList.soldAt;
      }
    },
  };
}
