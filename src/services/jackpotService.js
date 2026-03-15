import { ethers } from "ethers";
import { config } from "../config.js";
import { getContractHexBalance, transferHex } from "../chain/client.js";
import {
  getWallet,
  getHistory,
  createWithdrawRequest,
  getConfig,
  markClaimPaid,
  getClaimById,
  markClaimRejected,
  getPublicStats,
  getClaimsList,
  getUserClaims,
  getLastKnownBalanceWei,
} from "./jackpotRepo.js";
import { validateDailyPayoutLimit } from "./securityService.js";

// RPC 호출에 ms 제한 — 초과 시 캐시 fallback
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("RPC_TIMEOUT")), ms),
    ),
  ]);
}

export async function getCurrentJackpot() {
  // ── 1. 잔액: RPC → Firestore 캐시 → 0 순서로 fallback ──
  let balanceWei = 0n;
  let rpcLive = true;
  try {
    balanceWei = await withTimeout(getContractHexBalance(), 5_000);
  } catch {
    rpcLive = false;
    try { balanceWei = await getLastKnownBalanceWei(); } catch { /* 0n */ }
  }

  // ── 2. config: Firestore → default 순서로 fallback ──
  let cfg;
  try {
    cfg = await getConfig();
  } catch {
    cfg = {
      payoutScale: config.defaults.payoutScale,
      maxWinPercent: config.defaults.maxWinPercent,
      enabled: config.defaults.enabled,
    };
  }

  const jackpotWei = balanceWei / 2n;
  return {
    contractBalanceWei: balanceWei.toString(),
    contractBalanceHex: ethers.formatUnits(balanceWei, config.hexDecimals),
    jackpotDisplayWei: jackpotWei.toString(),
    jackpotDisplayHex: ethers.formatUnits(jackpotWei, config.hexDecimals),
    payoutScale: cfg.payoutScale.toString(),
    maxWinPercent: cfg.maxWinPercent,
    enabled: cfg.enabled,
    rpcLive,
  };
}

export async function getJackpotPublicStats() {
  const stats = await getPublicStats();
  return {
    winnerCount: stats.winnerCount,
    highestWinWei: stats.highestWinWei.toString(),
    highestWinHex: ethers.formatUnits(stats.highestWinWei, config.hexDecimals),
    lastRoundAt: stats.lastRoundAt,
  };
}

export async function getUserBalance(wallet) {
  return getWallet(wallet);
}

export async function getUserHistory(wallet, limit) {
  return getHistory(wallet, limit);
}

export async function requestWithdraw({ wallet, amountHex }) {
  const cfg = await getConfig();
  const requestedWei = ethers.parseUnits(String(amountHex), config.hexDecimals);

  if (requestedWei < cfg.minClaimWei) {
    throw new Error("MIN_CLAIM_NOT_MET");
  }

  const claim = await createWithdrawRequest({ userAddress: wallet, requestedWei });

  if (!config.autoApproveWithdraw) {
    return {
      claimId: claim.id,
      status: claim.status,
      requestedAt: claim.requestedAt,
      txHash: null,
    };
  }

  await validateDailyPayoutLimit(requestedWei);
  const txHash = await transferHex({ to: wallet, amountWei: requestedWei });

  await markClaimPaid({ claimId: claim.id, txHash, approvedWei: requestedWei });

  return {
    claimId: claim.id,
    status: "paid",
    requestedAt: claim.requestedAt,
    txHash,
  };
}

export async function adminApproveWithdraw({ claimId }) {
  const claim = await getClaimById(claimId);
  if (!claim) throw new Error("CLAIM_NOT_FOUND");
  if (claim.status !== "requested") throw new Error("INVALID_CLAIM_STATUS");

  const approvedWei = BigInt(claim.requestedWei);
  await validateDailyPayoutLimit(approvedWei);

  const txHash = await transferHex({ to: claim.userAddress, amountWei: approvedWei });
  await markClaimPaid({ claimId, txHash, approvedWei });

  return { claimId, status: "paid", txHash };
}

export async function adminRejectWithdraw({ claimId }) {
  const claim = await getClaimById(claimId);
  if (!claim) throw new Error("CLAIM_NOT_FOUND");
  if (claim.status !== "requested") throw new Error("INVALID_CLAIM_STATUS");

  await markClaimRejected(claimId);
  return { claimId, status: "rejected" };
}

export async function adminListClaims({ status, limit }) {
  return getClaimsList({ status: status || null, limitCount: limit ?? 100 });
}

export async function getMyWithdrawals(wallet, limit) {
  return getUserClaims(wallet, limit ?? 50);
}
