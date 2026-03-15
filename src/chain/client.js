import { ethers } from "ethers";
import { config } from "../config.js";
import { ERC20_ABI, PAYMENT_EVENT_ABI } from "./abi.js";

// opBNB 공개 RPC 목록 — 순서대로 시도
const RPC_URLS = [
  config.rpcUrl,
  "https://opbnb.publicnode.com",
  "https://opbnb-mainnet-rpc.bnbchain.org",
].filter((v, i, a) => v && a.indexOf(v) === i);

const FETCH_TIMEOUT_MS = 8_000;

function makeProvider(url) {
  const req = new ethers.FetchRequest(url);
  req.timeout = FETCH_TIMEOUT_MS;
  return new ethers.JsonRpcProvider(req, config.chainId, {
    staticNetwork: true,
    pollingInterval: config.pollIntervalMs,
  });
}

// 단순 retry: 첫 번째 RPC 실패 시 다음 URL로 순서대로 시도
async function withFallback(fn) {
  let lastErr;
  for (const url of RPC_URLS) {
    try {
      return await fn(makeProvider(url));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// 기본 provider (paymentContract / hexTokenRead 생성용)
export const provider = makeProvider(RPC_URLS[0]);

export const paymentContract = new ethers.Contract(
  config.paymentContractAddress,
  PAYMENT_EVENT_ABI,
  provider,
);

export const hexTokenRead = new ethers.Contract(
  config.hexTokenAddress,
  ERC20_ABI,
  provider,
);

export function getHexTokenWriteContract() {
  if (!config.hotWalletPrivateKey) {
    throw new Error("HOT_WALLET_PRIVATE_KEY_MISSING");
  }
  const signer = new ethers.Wallet(config.hotWalletPrivateKey, provider);
  return new ethers.Contract(config.hexTokenAddress, ERC20_ABI, signer);
}

export async function getContractHexBalance() {
  return withFallback(async (p) => {
    const contract = new ethers.Contract(config.hexTokenAddress, ERC20_ABI, p);
    return BigInt(await contract.balanceOf(config.paymentContractAddress));
  });
}

export async function getReceipt(txHash) {
  return withFallback((p) => p.getTransactionReceipt(txHash));
}

export async function getCurrentBlock() {
  return withFallback((p) => p.getBlockNumber());
}

export async function transferHex({ to, amountWei }) {
  const token = getHexTokenWriteContract();
  const tx = await token.transfer(to, amountWei, {
    gasLimit: BigInt(config.withdrawGasLimit),
  });
  const receipt = await tx.wait(config.confirmations);
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error("WITHDRAW_TX_FAILED");
  }
  return tx.hash;
}
