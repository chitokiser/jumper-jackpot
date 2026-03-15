import { ethers } from "ethers";
import { config } from "../config.js";
import { ERC20_ABI, PAYMENT_EVENT_ABI } from "./abi.js";

// opBNB 공개 RPC 목록 — 주 URL 실패 시 순서대로 시도
const RPC_FALLBACKS = [
  config.rpcUrl,
  "https://opbnb.publicnode.com",
  "https://opbnb-mainnet-rpc.bnbchain.org",
].filter((v, i, a) => v && a.indexOf(v) === i); // dedupe

const FETCH_TIMEOUT_MS = 8_000;
const STALL_TIMEOUT_MS = FETCH_TIMEOUT_MS + 2_000; // stall은 fetch보다 늦게 터져야 함

function makeFetchReq(url) {
  const r = new ethers.FetchRequest(url);
  r.timeout = FETCH_TIMEOUT_MS;
  return r;
}

function makeSingleProvider(url) {
  return new ethers.JsonRpcProvider(makeFetchReq(url), config.chainId, {
    staticNetwork: true,
    pollingInterval: config.pollIntervalMs,
  });
}

// FallbackProvider: 첫 번째 응답을 사용 (quorum=1)
export const provider = RPC_FALLBACKS.length > 1
  ? new ethers.FallbackProvider(
      RPC_FALLBACKS.map((url, i) => ({
        provider: makeSingleProvider(url),
        priority: i + 1,
        stallTimeout: STALL_TIMEOUT_MS,
        weight: 1,
      })),
      config.chainId,
      { quorum: 1 },
    )
  : makeSingleProvider(RPC_FALLBACKS[0]);

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
  return BigInt(await hexTokenRead.balanceOf(config.paymentContractAddress));
}

export async function getReceipt(txHash) {
  return provider.getTransactionReceipt(txHash);
}

export async function getCurrentBlock() {
  return provider.getBlockNumber();
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
