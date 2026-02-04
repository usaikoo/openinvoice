/**
 * Solana Payment Utilities
 * Helper functions for Solana token payments (USDC, USDT, SOL, etc.)
 */

import {
  Connection,
  PublicKey,
  ParsedAccountData,
  ParsedTransactionWithMeta,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getMint } from '@solana/spl-token';

// Solana token mint addresses (mainnet)
export const SOLANA_MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  SOL: 'So11111111111111111111111111111111111111112' // Wrapped SOL
};

// Solana token mint addresses (testnet)
export const SOLANA_MINTS_TESTNET = {
  USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Testnet USDC
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // Same on testnet
  SOL: 'So11111111111111111111111111111111111111112' // Same on testnet
};

/**
 * Get Solana RPC connection
 */
export function getSolanaConnection(isTestnet: boolean = false): Connection {
  const rpcUrl = isTestnet
    ? process.env.SOLANA_TESTNET_RPC_URL || 'https://api.testnet.solana.com'
    : process.env.SOLANA_MAINNET_RPC_URL ||
      'https://api.mainnet-beta.solana.com';

  return new Connection(rpcUrl, 'confirmed');
}

/**
 * Get mint address for a cryptocurrency code
 */
export function getMintAddress(
  cryptocurrency: string,
  isTestnet: boolean = false
): string {
  const crypto = cryptocurrency.toLowerCase();
  const mints = isTestnet ? SOLANA_MINTS_TESTNET : SOLANA_MINTS;

  switch (crypto) {
    case 'usdc':
      return mints.USDC;
    case 'usdt':
      return mints.USDT;
    case 'sol':
      return mints.SOL;
    default:
      throw new Error(`Unsupported Solana token: ${cryptocurrency}`);
  }
}

/**
 * Derive Associated Token Account (ATA) address
 */
export async function getTokenAccountAddress(
  walletAddress: string,
  mintAddress: string
): Promise<string> {
  try {
    const walletPubkey = new PublicKey(walletAddress);
    const mintPubkey = new PublicKey(mintAddress);
    const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey);
    return ata.toString();
  } catch (error) {
    console.error('[Solana] Error deriving token account address:', error);
    throw error;
  }
}

/**
 * Get token account balance
 */
export async function getTokenAccountBalance(
  tokenAccountAddress: string,
  isTestnet: boolean = false
): Promise<{
  amount: bigint;
  decimals: number;
  uiAmount: number;
}> {
  const connection = getSolanaConnection(isTestnet);
  const tokenAccountPubkey = new PublicKey(tokenAccountAddress);

  try {
    const accountInfo =
      await connection.getParsedAccountInfo(tokenAccountPubkey);

    if (!accountInfo.value) {
      return {
        amount: BigInt(0),
        decimals: 0,
        uiAmount: 0
      };
    }

    const parsedData = accountInfo.value.data as ParsedAccountData;
    if (!parsedData.parsed?.info?.tokenAmount) {
      return {
        amount: BigInt(0),
        decimals: 0,
        uiAmount: 0
      };
    }

    const tokenAmount = parsedData.parsed.info.tokenAmount;
    return {
      amount: BigInt(tokenAmount.amount),
      decimals: tokenAmount.decimals,
      uiAmount: tokenAmount.uiAmount || 0
    };
  } catch (error) {
    console.error('[Solana] Error fetching token account balance:', error);
    throw error;
  }
}

/**
 * Check if token account exists
 */
export async function tokenAccountExists(
  tokenAccountAddress: string,
  isTestnet: boolean = false
): Promise<boolean> {
  try {
    const balance = await getTokenAccountBalance(
      tokenAccountAddress,
      isTestnet
    );
    // Use Number() to safely compare against zero, supporting environments without BigInt
    return Number(balance.amount) > 0 || balance.uiAmount > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Get recent transactions for a token account
 */
export async function getTokenAccountTransactions(
  tokenAccountAddress: string,
  limit: number = 10,
  isTestnet: boolean = false
): Promise<
  Array<{
    signature: string;
    amount: string;
    from?: string;
    timestamp?: number;
    slot?: number;
  }>
> {
  const connection = getSolanaConnection(isTestnet);
  const tokenAccountPubkey = new PublicKey(tokenAccountAddress);

  try {
    const signatures = await connection.getSignaturesForAddress(
      tokenAccountPubkey,
      { limit }
    );

    if (!signatures || signatures.length === 0) {
      return [];
    }

    const transactions = await Promise.all(
      signatures.map(async (sigInfo) => {
        try {
          const tx = await connection.getTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0
          });

          if (!tx) return null;

          // Parse transaction to extract token transfer details
          // Handle both legacy and versioned transactions
          const parsedTx = tx as unknown as ParsedTransactionWithMeta;
          let amount = '0';
          let from: string | undefined;

          // Check if this is a native SOL transfer or SPL token transfer
          // For native SOL: check preBalances and postBalances
          // For SPL tokens: check postTokenBalances

          // First, try to extract from token balances (SPL tokens)
          if (parsedTx.meta?.postTokenBalances) {
            for (const balance of parsedTx.meta.postTokenBalances) {
              if (
                balance.owner === tokenAccountAddress ||
                balance.accountIndex !== undefined
              ) {
                amount = balance.uiTokenAmount.uiAmountString || '0';
              }
            }
          }

          // Extract sender from account keys (needed for both SOL and token transfers)
          // Handle both legacy and versioned transactions
          let accountKeys: any[] = [];
          try {
            if ('accountKeys' in parsedTx.transaction.message) {
              accountKeys = parsedTx.transaction.message.accountKeys;
            } else if ('getAccountKeys' in parsedTx.transaction.message) {
              accountKeys = (
                parsedTx.transaction.message as any
              ).getAccountKeys().staticAccountKeys;
            }
          } catch (e) {
            console.warn('[Solana] Could not extract account keys:', e);
          }

          // If no token balance found, check native SOL balance changes
          // This handles native SOL transfers to wallet addresses
          if (
            amount === '0' &&
            parsedTx.meta?.preBalances &&
            parsedTx.meta?.postBalances &&
            accountKeys.length > 0
          ) {
            // Find the account index for our address
            const targetAccountIndex = accountKeys.findIndex((key: any) => {
              try {
                const pubkey =
                  key instanceof PublicKey ? key : key?.pubkey || key;
                return pubkey && pubkey.toString() === tokenAccountAddress;
              } catch {
                return false;
              }
            });

            if (
              targetAccountIndex >= 0 &&
              targetAccountIndex < parsedTx.meta.preBalances.length
            ) {
              const preBalance = parsedTx.meta.preBalances[targetAccountIndex];
              const postBalance =
                parsedTx.meta.postBalances[targetAccountIndex];
              const balanceChange = postBalance - preBalance;

              // Only consider positive balance changes (incoming payments)
              if (balanceChange > 0) {
                amount = (balanceChange / LAMPORTS_PER_SOL).toString();
              }
            }
          }

          if (accountKeys.length > 0) {
            // The first signer is usually the sender
            // Handle both PublicKey objects and objects with pubkey property
            const firstKey = accountKeys[0];
            if (firstKey instanceof PublicKey) {
              from = firstKey.toString();
            } else if (
              firstKey &&
              typeof firstKey === 'object' &&
              'pubkey' in firstKey
            ) {
              from = firstKey.pubkey.toString();
            } else if (firstKey && typeof firstKey === 'string') {
              from = firstKey;
            }
          }

          return {
            signature: sigInfo.signature,
            amount,
            from,
            timestamp: tx.blockTime || undefined,
            slot: tx.slot || undefined
          };
        } catch (error) {
          console.error(
            `[Solana] Error parsing transaction ${sigInfo.signature}:`,
            error
          );
          return null;
        }
      })
    );

    return transactions.filter(
      (tx): tx is NonNullable<typeof tx> => tx !== null
    );
  } catch (error) {
    console.error('[Solana] Error fetching transactions:', error);
    throw error;
  }
}

/**
 * Find transactions matching a payment amount
 */
export async function findMatchingTransaction(
  tokenAccountAddress: string,
  expectedAmount: string,
  sinceTimestamp: Date,
  isTestnet: boolean = false
): Promise<{
  signature: string;
  amount: string;
  from?: string;
  timestamp?: number;
} | null> {
  const transactions = await getTokenAccountTransactions(
    tokenAccountAddress,
    100,
    isTestnet
  );

  const expectedAmountNum = parseFloat(expectedAmount);
  const since = Math.floor(sinceTimestamp.getTime() / 1000);

  for (const tx of transactions) {
    // Check timestamp
    if (tx.timestamp && tx.timestamp < since) {
      continue;
    }

    // Check amount (with tolerance)
    const txAmount = parseFloat(tx.amount);
    if (
      txAmount >= expectedAmountNum * 0.99 &&
      txAmount <= expectedAmountNum * 1.01
    ) {
      return tx;
    }
  }

  return null;
}

/**
 * Get transaction details by signature
 */
export async function getTransactionDetails(
  signature: string,
  isTestnet: boolean = false
): Promise<{
  signature: string;
  amount: string;
  from?: string;
  timestamp?: number;
  slot?: number;
  confirmations: number;
} | null> {
  const connection = getSolanaConnection(isTestnet);

  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });

    if (!tx) return null;

    // Handle both legacy and versioned transactions
    const parsedTx = tx as unknown as ParsedTransactionWithMeta;
    let amount = '0';
    let from: string | undefined;

    // Extract token transfer amount
    if (parsedTx.meta?.postTokenBalances) {
      for (const balance of parsedTx.meta.postTokenBalances) {
        if (balance.uiTokenAmount.uiAmountString) {
          amount = balance.uiTokenAmount.uiAmountString;
        }
      }
    }

    // Extract sender from account keys
    // Handle both legacy and versioned transactions
    let accountKeys: any[] = [];
    try {
      if ('accountKeys' in parsedTx.transaction.message) {
        accountKeys = parsedTx.transaction.message.accountKeys;
      } else if ('getAccountKeys' in parsedTx.transaction.message) {
        accountKeys = (parsedTx.transaction.message as any).getAccountKeys()
          .staticAccountKeys;
      }
    } catch (e) {
      // Account keys extraction failed, continue without sender info
    }

    if (accountKeys.length > 0) {
      // The first signer is usually the sender
      // Handle both PublicKey objects and objects with pubkey property
      const firstKey = accountKeys[0];
      if (firstKey instanceof PublicKey) {
        from = firstKey.toString();
      } else if (
        firstKey &&
        typeof firstKey === 'object' &&
        'pubkey' in firstKey
      ) {
        from = firstKey.pubkey.toString();
      } else if (firstKey && typeof firstKey === 'string') {
        from = firstKey;
      }
    }

    // Get current slot for confirmations
    const currentSlot = await connection.getSlot('confirmed');
    const confirmations = tx.slot ? currentSlot - tx.slot + 1 : 0;

    return {
      signature,
      amount,
      from,
      timestamp: tx.blockTime || undefined,
      slot: tx.slot || undefined,
      confirmations
    };
  } catch (error) {
    console.error('[Solana] Error fetching transaction details:', error);
    return null;
  }
}

/**
 * Get explorer URL for a transaction
 */
export function getSolanaExplorerUrl(
  signature: string,
  isTestnet: boolean = false
): string {
  if (isTestnet) {
    return `https://explorer.solana.com/tx/${signature}?cluster=testnet`;
  }
  return `https://explorer.solana.com/tx/${signature}`;
}
