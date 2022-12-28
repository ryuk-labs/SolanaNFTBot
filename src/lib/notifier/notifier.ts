import { Config } from "config";
import Discord from "discord.js";
import { initClient as initDiscordClient } from "lib/discord";
import notifyDiscordList from "lib/discord/notifyDiscordList";
import notifyDiscordSale from "lib/discord/notifyDiscordSale";
import logger from "lib/logger";
import initTwitterClient from "lib/twitter";
import notifyTwitter from "lib/twitter/notifyTwitter";
import queue from "queue";
import { Project } from "workers/notifyNFTSalesWorker";

export enum NotificationType {
  Sale,
  List,
}

export interface Notifier {
  notify: (nType: NotificationType, data: any) => Promise<void>;
}

export enum Platform {
  Twitter = "Twitter",
  Discord = "Discord",
  Webhook = "Webhook",
}

function queueNotification(
  nQueue: queue,
  platform: Platform,
  callback: () => Promise<void>
) {
  nQueue.push(() => {
    try {
      return callback();
    } catch (err) {
      logNotificationError(err, platform);
    }
  });
}

export async function newNotifierFactory(config: Config, nQueue: queue) {
  let discordClient: Discord.Client;
  if (config.discordBotToken) {
    discordClient = await initDiscordClient(config.discordBotToken);
  }

  const twitterClient = await initTwitterClient(config.twitter);

  return {
    create(project: Project): Notifier {
      async function notifySale(data: any) {
        if (discordClient) {
          queueNotification(nQueue, Platform.Discord, async () => {
            await notifyDiscordSale(
              discordClient,
              project.discordChannelId,
              data
            );
          });
        }

        if (twitterClient) {
          queueNotification(nQueue, Platform.Twitter, async () => {
            await notifyTwitter(twitterClient, data);
          });
        }
      }

      async function notifyList(data: any) {
        if (discordClient) {
          queueNotification(nQueue, Platform.Discord, async () => {
            await notifyDiscordList(
              discordClient,
              project.discordChannelId,
              data
            );
          });
        }

        if (twitterClient) {
          queueNotification(nQueue, Platform.Twitter, async () => {
            await notifyTwitter(twitterClient, data);
          });
        }
      }

      return {
        async notify(nType: NotificationType, data: any) {
          if (nType === NotificationType.Sale) {
            await notifySale(data);
            return;
          }
          if (nType === NotificationType.List) {
            await notifyList(data);
            return;
          }
        },
      };
    },
  };
}

function logNotificationError(err: unknown, platform: string) {
  logger.error(`Error occurred when notifying ${platform}`, err);
}
