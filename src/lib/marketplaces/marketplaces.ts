import alphaArt from "./alphaArt";
import digitalEyes from "./digitalEyes";
import exchangeArt from "./exchangeArt";
import openSea from "./openSea";
import solanart from "./solanart";
import solsea from "./solsea";
import { Marketplace } from "./types";

/**
 * These are the list of marketplaces that we check for notifications
 */
const marketplaces: Marketplace[] = [
  digitalEyes,
  solanart,
  alphaArt,
  exchangeArt,
  solsea,
  openSea,
];

export default marketplaces;
