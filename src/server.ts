import { ParsedTransactionWithMeta } from "@solana/web3.js";
import axios from "axios";
import { Env, loadConfig } from "config";
import dotenv from "dotenv";
import express from "express";
import { initClient as initDiscordClient } from "lib/discord";
import notifyDiscordList from "lib/discord/notifyDiscordList";
import notifyDiscordSale, { getStatus } from "lib/discord/notifyDiscordSale";
import logger from "lib/logger";
import { NFTSale, parseNFTSale, SaleMethod } from "lib/marketplaces";
import MagicEden from "lib/marketplaces/magicEden";
import { newNotifierFactory } from "lib/notifier";
import {
  maxSupportedTransactionVersion,
  newConnection,
} from "lib/solana/connection";
import { fetchNFTData } from "lib/solana/NFTData";
import initTwitterClient from "lib/twitter";
import notifyTwitter from "lib/twitter/notifyTwitter";
import queue from "queue";
import initWorkers from "workers/initWorkers";
import notifyMagicEdenNFTListingWorker from "workers/notifyMagicEdenNFTListingWorker";
import notifyMagicEdenNFTSalesWorker, {
  CollectionActivity,
} from "workers/notifyMagicEdenNFTSalesWorker";
import notifyNFTSalesWorker from "workers/notifyNFTSalesWorker";
import { Worker } from "workers/types";

(async () => {
  try {
    const result = dotenv.config();
    if (result.error) {
      throw result.error;
    }

    const config = loadConfig(process.env as Env);
    const { subscriptions } = config;
    const port = process.env.PORT || 4000;

    const web3Conn = newConnection();

    const nQueue = queue({
      concurrency: config.queueConcurrency,
      autostart: true,
    });

    const notifierFactory = await newNotifierFactory(config, nQueue);

    const server = express();
    server.get("/", (req, res) => {
      const { totalNotified, lastNotified } = getStatus();
      res.send(`
      ${subscriptions.map(
        (s) =>
          `Watching the address ${s.mintAddress} at discord channel #${s.discordChannelId} for NFT sales.<br/>`
      )}
      Total notifications sent: ${totalNotified}<br/>
      ${
        lastNotified
          ? `Last notified at: ${lastNotified.toISOString()}<br/>`
          : ""
      }
      ${`Current UTC time: ${new Date().toISOString()}`}
      `);
    });

    server.get("/test-sale-tx", async (req, res) => {
      const signature = (req.query["signature"] as string) || "";
      if (!signature) {
        res.send(`no signature in query param`);
        return;
      }

      let tx: ParsedTransactionWithMeta | null = null;
      try {
        tx = await web3Conn.getParsedTransaction(signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion,
        });
      } catch (e) {
        logger.log(e);
        res.send(`Get transaction failed, check logs for error.`);
        return;
      }
      if (!tx) {
        res.send(`No transaction found for ${signature}`);
        return;
      }
      const nftSale = await parseNFTSale(web3Conn, tx);
      if (!nftSale) {
        res.send(
          `No NFT Sale detected for tx: ${signature}\n${JSON.stringify(tx)}`
        );
        return;
      }
      if (config.discordBotToken) {
        const discordClient = await initDiscordClient(config.discordBotToken);
        if (discordClient) {
          const channelId = (req.query["channelId"] as string) || "";
          await notifyDiscordSale(discordClient, channelId, nftSale);
        }
      }

      const twitterClient = await initTwitterClient(config.twitter);
      const sendTweet = (req.query["tweet"] as string) || "";
      if (sendTweet && twitterClient) {
        await notifyTwitter(twitterClient, nftSale).catch((err) => {
          logger.error("Error occurred when notifying twitter", err);
        });
      }

      res.send(`NFT Sales parsed: \n${JSON.stringify(nftSale)}`);
    });

    server.get("/test-list-tx", async (req, res) => {
      const signature = (req.query["signature"] as string) || "";
      if (!signature) {
        res.send(`no signature in query param`);
        return;
      }

      let activities: CollectionActivity[] = [];
      try {
        // Reference: https://api.magiceden.dev/#95fed531-fd1f-4cbb-8137-30e0f2294cd7
        const res = await axios.get(
          `${config.magicEdenConfig.url}/collections/${config.magicEdenConfig.collection}/activities?offset=0&limit=1000`
        );
        activities = res.data as CollectionActivity[];
      } catch (e) {
        logger.error(e);
        res.send(e);
        return;
      }

      const sortByEarliest = activities.sort(
        (a: CollectionActivity, b: CollectionActivity) => {
          return a.blockTime - b.blockTime;
        }
      );

      const activity = activities.find((item) => item.signature === signature);
      if (!activity) {
        res.send(`signature not found`);
        return;
      }

      if (activity.type !== "list") {
        res.send(`type !== list`);
        return;
      }

      const nftData = await fetchNFTData(web3Conn, activity.tokenMint);
      if (!nftData) {
        res.send(`nftData invalid`);
        return;
      }
      if (
        config.magicEdenConfig.degensToWatch?.includes(
          nftData.name.split("#")[1]
        ) === false
      ) {
        res.send(`${nftData.name} not in watch list`);
        return;
      }
      const nftSale: NFTSale = {
        transaction: activity.signature,
        soldAt: new Date((activity.blockTime || 0) * 1000),
        seller: activity.seller,
        buyer: activity.buyer,
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
      if (config.discordBotToken) {
        const discordClient = await initDiscordClient(config.discordBotToken);
        if (discordClient) {
          const channelId = (req.query["channelId"] as string) || "";
          await notifyDiscordList(discordClient, channelId, nftSale);
        }
      }

      const twitterClient = await initTwitterClient(config.twitter);
      const sendTweet = (req.query["tweet"] as string) || "";
      if (sendTweet && twitterClient) {
        await notifyTwitter(twitterClient, nftSale).catch((err) => {
          logger.error("Error occurred when notifying twitter", err);
        });
      }

      res.send(`NFT Sales parsed: \n${JSON.stringify(nftSale)}`);
    });

    server.listen(port, (err?: any) => {
      if (err) throw err;
      logger.log(`Ready on http://localhost:${port}`);
    });

    let workers: Worker[] = [];
    if (subscriptions.length) {
      workers = subscriptions.map((s) => {
        const project = {
          discordChannelId: s.discordChannelId,
          mintAddress: s.mintAddress,
        };
        const notifier = notifierFactory.create(project);
        return notifyNFTSalesWorker(notifier, web3Conn, project);
      });
    }

    if (config.magicEdenConfig.collection) {
      const notifier = notifierFactory.create({
        discordChannelId: config.magicEdenConfig?.discordChannelId,
        mintAddress: "",
      });
      workers.push(
        notifyMagicEdenNFTSalesWorker(
          notifier,
          web3Conn,
          config.magicEdenConfig
        )
      );
      workers.push(
        notifyMagicEdenNFTListingWorker(
          notifier,
          web3Conn,
          config.magicEdenConfig
        )
      );
    }

    const _ = initWorkers(workers, () => {
      // Add randomness between worker executions so the requests are not made all at once
      return Math.random() * 5000; // 0-5s
    });
  } catch (e) {
    logger.error(e);
    process.exit(1);
  }
})();
