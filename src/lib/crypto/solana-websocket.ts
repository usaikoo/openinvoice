/**
 * Solana WebSocket Monitor
 * Real-time transaction monitoring using Solana WebSocket subscriptions
 * Monitors token account balances for incoming payments
 * Uses @solana/web3.js for compatibility with existing code
 */

import {
  Connection,
  PublicKey,
  ParsedAccountData,
  AccountInfo,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

interface SolanaWebSocketConfig {
  tokenAccountAddress: string; // Associated Token Account (ATA) address OR wallet address for native SOL
  mintAddress: string; // Token mint address (USDC, USDT, SOL, etc.)
  walletAddress?: string; // Wallet address (for native SOL monitoring)
  isNativeSOL?: boolean; // True if monitoring native SOL (not wrapped SOL token)
  onTransaction: (tx: SolanaTransaction) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  isTestnet?: boolean;
}

interface SolanaTransaction {
  signature: string;
  amount: string; // Token amount as string
  from: string;
  to: string;
  slot?: number;
  timestamp?: number;
  confirmed: boolean;
}

class SolanaWebSocketMonitor {
  private connection: Connection | null = null;
  private config: SolanaWebSocketConfig;
  private isIntentionallyClosed = false;
  private connectionFailed = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private subscriptionId: number | null = null;
  private lastBalance: bigint = BigInt(0);
  private lastNativeBalance: number = 0; // For native SOL monitoring

  constructor(config: SolanaWebSocketConfig) {
    this.config = config;
  }

  /**
   * Connect to Solana RPC endpoint
   */
  async connect(): Promise<void> {
    if (this.connection && !this.isIntentionallyClosed) {
      return;
    }

    if (this.isConnecting) {
      return;
    }

    if (this.connectionFailed) {
      return;
    }

    this.isIntentionallyClosed = false;
    this.isConnecting = true;

    // Use Solana RPC endpoints
    const rpcUrl = this.config.isTestnet
      ? process.env.SOLANA_TESTNET_RPC_URL || 'https://api.testnet.solana.com'
      : process.env.SOLANA_MAINNET_RPC_URL ||
        'https://api.mainnet-beta.solana.com';

    try {
      this.connection = new Connection(rpcUrl, 'confirmed');

      // Verify connection
      await this.connection.getVersion();

      this.connectionFailed = false;
      this.isConnecting = false;

      // Wait a bit for connection to be fully ready before subscribing
      setTimeout(() => {
        this.subscribe();
      }, 100);

      this.config.onConnect?.();
    } catch (error: any) {
      this.isConnecting = false;

      const isTimeoutError =
        error?.message?.includes('timed out') ||
        error?.message?.includes('timeout') ||
        error?.code === 'ETIMEDOUT';

      if (isTimeoutError) {
        console.warn(
          '[Solana WebSocket] Connection timeout - will use polling instead'
        );
        this.connectionFailed = true;
        this.config.onError?.(
          new Error('WebSocket connection timeout - using polling instead')
        );
      } else {
        this.connectionFailed = true;
        this.config.onError?.(error as Error);
      }
      throw error;
    }
  }

  /**
   * Subscribe to token account changes or native SOL wallet changes
   */
  private async subscribe(): Promise<void> {
    if (!this.connection) {
      return;
    }

    try {
      const accountPubkey = new PublicKey(this.config.tokenAccountAddress);

      if (this.config.isNativeSOL && this.config.walletAddress) {
        // For native SOL, monitor the wallet address directly
        const walletPubkey = new PublicKey(this.config.walletAddress);

        // Get initial native SOL balance
        const balance = await this.connection.getBalance(walletPubkey);
        this.lastNativeBalance = balance;

        // Subscribe to native SOL balance changes
        this.subscriptionId = this.connection.onAccountChange(
          walletPubkey,
          (accountInfo: AccountInfo<Buffer | ParsedAccountData>) => {
            this.handleNativeSOLChange(accountInfo);
          },
          'confirmed'
        );
      } else {
        // For SPL tokens (USDC, USDT, wrapped SOL), monitor token account
        // Get initial balance
        const accountInfo =
          await this.connection.getParsedAccountInfo(accountPubkey);
        if (accountInfo.value) {
          const parsedData = accountInfo.value.data as ParsedAccountData;
          if (parsedData.parsed?.info?.tokenAmount) {
            this.lastBalance = BigInt(
              parsedData.parsed.info.tokenAmount.amount
            );
          }
        }

        // Subscribe to account changes
        this.subscriptionId = this.connection.onAccountChange(
          accountPubkey,
          (accountInfo: AccountInfo<Buffer | ParsedAccountData>) => {
            this.handleAccountChange(accountInfo);
          },
          'confirmed'
        );
      }
    } catch (error: any) {
      console.error('[Solana WebSocket] Error subscribing:', error);
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * Handle native SOL balance changes (for native SOL transfers)
   */
  private async handleNativeSOLChange(
    accountInfo: AccountInfo<Buffer | ParsedAccountData>
  ): Promise<void> {
    if (!this.connection || !this.config.walletAddress) return;

    try {
      // Get current native SOL balance
      const walletPubkey = new PublicKey(this.config.walletAddress);
      const currentBalance = await this.connection.getBalance(walletPubkey);

      // Check if balance increased (incoming payment)
      if (currentBalance > this.lastNativeBalance) {
        const amountReceivedLamports = currentBalance - this.lastNativeBalance;
        const amountDecimal = amountReceivedLamports / LAMPORTS_PER_SOL;

        // Fetch recent transactions to get signature
        const tx = await this.fetchRecentTransactionForWallet(
          this.config.walletAddress
        );
        if (tx) {
          const solanaTransaction: SolanaTransaction = {
            signature: tx.signature,
            amount: amountDecimal.toString(),
            from: tx.from || 'unknown',
            to: this.config.walletAddress,
            slot: tx.slot,
            timestamp: tx.timestamp,
            confirmed: true
          };
          this.config.onTransaction(solanaTransaction);
        }
      }

      this.lastNativeBalance = currentBalance;
    } catch (error) {
      console.error(
        '[Solana WebSocket] Error handling native SOL change:',
        error
      );
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * Handle account balance changes (for SPL tokens)
   */
  private handleAccountChange(
    accountInfo: AccountInfo<Buffer | ParsedAccountData>
  ): void {
    try {
      const parsedData = accountInfo.data as ParsedAccountData;
      if (!parsedData.parsed?.info?.tokenAmount) {
        return;
      }

      const currentBalance = BigInt(parsedData.parsed.info.tokenAmount.amount);
      const decimals = parsedData.parsed.info.tokenAmount.decimals;

      // Check if balance increased (incoming payment)
      if (currentBalance > this.lastBalance) {
        const amountReceived = currentBalance - this.lastBalance;
        const amountDecimal = Number(amountReceived) / Math.pow(10, decimals);

        // Fetch recent transactions to get signature
        this.fetchRecentTransaction()
          .then((tx) => {
            if (tx) {
              const solanaTransaction: SolanaTransaction = {
                signature: tx.signature,
                amount: amountDecimal.toString(),
                from: tx.from || 'unknown',
                to: this.config.tokenAccountAddress,
                slot: tx.slot,
                timestamp: tx.timestamp,
                confirmed: true
              };
              this.config.onTransaction(solanaTransaction);
            }
          })
          .catch((error) => {
            console.error(
              '[Solana WebSocket] Error fetching transaction:',
              error
            );
          });
      }

      this.lastBalance = currentBalance;
    } catch (error) {
      console.error('[Solana WebSocket] Error handling account change:', error);
      // If there's an error, try to reconnect
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * Handle connection errors and attempt reconnection
   */
  private handleConnectionError(error: Error): void {
    console.warn('[Solana WebSocket] Connection error detected:', error);

    // Don't reconnect if intentionally closed or already failed
    if (this.isIntentionallyClosed || this.connectionFailed) {
      return;
    }

    // Clear subscription
    if (this.subscriptionId !== null && this.connection) {
      this.connection
        .removeAccountChangeListener(this.subscriptionId)
        .catch(() => {});
      this.subscriptionId = null;
    }

    // Attempt reconnection after a delay
    if (!this.reconnectTimeout) {
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null;
        this.connection = null; // Clear old connection
        this.connect().catch((reconnectError) => {
          console.error(
            '[Solana WebSocket] Reconnection failed:',
            reconnectError
          );
          this.connectionFailed = true;
          this.config.onError?.(
            new Error('WebSocket reconnection failed - falling back to polling')
          );
        });
      }, 3000);
    }
  }

  /**
   * Fetch the most recent transaction for this token account
   */
  private async fetchRecentTransaction(): Promise<{
    signature: string;
    from?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    if (!this.connection) return null;

    try {
      const tokenAccountPubkey = new PublicKey(this.config.tokenAccountAddress);
      const signatures = await this.connection.getSignaturesForAddress(
        tokenAccountPubkey,
        { limit: 1 }
      );

      if (signatures.length === 0) return null;

      const signature = signatures[0].signature;
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });

      if (!tx) return null;

      // Extract sender address from transaction
      let from: string | undefined;
      // Handle both legacy and versioned transactions
      let accountKeys: any[] = [];
      try {
        if ('accountKeys' in tx.transaction.message) {
          accountKeys = tx.transaction.message.accountKeys;
        } else if ('getAccountKeys' in tx.transaction.message) {
          accountKeys = (tx.transaction.message as any).getAccountKeys()
            .staticAccountKeys;
        }
      } catch (e) {
        // Account keys extraction failed, continue without sender info
      }

      if (accountKeys.length > 0) {
        // The first signer is usually the sender
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
        signature,
        from,
        slot: tx.slot || undefined,
        timestamp: tx.blockTime || undefined
      };
    } catch (error) {
      console.error(
        '[Solana WebSocket] Error fetching recent transaction:',
        error
      );
      return null;
    }
  }

  /**
   * Fetch the most recent transaction for a wallet address (for native SOL)
   */
  private async fetchRecentTransactionForWallet(
    walletAddress: string
  ): Promise<{
    signature: string;
    from?: string;
    slot?: number;
    timestamp?: number;
  } | null> {
    if (!this.connection) return null;

    try {
      const walletPubkey = new PublicKey(walletAddress);
      const signatures = await this.connection.getSignaturesForAddress(
        walletPubkey,
        { limit: 1 }
      );

      if (signatures.length === 0) return null;

      const signature = signatures[0].signature;
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });

      if (!tx) return null;

      // Extract sender address from transaction
      let from: string | undefined;
      // Handle both legacy and versioned transactions
      let accountKeys: any[] = [];
      try {
        if ('accountKeys' in tx.transaction.message) {
          accountKeys = tx.transaction.message.accountKeys;
        } else if ('getAccountKeys' in tx.transaction.message) {
          accountKeys = (tx.transaction.message as any).getAccountKeys()
            .staticAccountKeys;
        }
      } catch (e) {
        // Account keys extraction failed, continue without sender info
      }

      if (accountKeys.length > 0) {
        // The first signer is usually the sender
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
        signature,
        from,
        slot: tx.slot || undefined,
        timestamp: tx.blockTime || undefined
      };
    } catch (error) {
      console.error(
        '[Solana WebSocket] Error fetching recent transaction for wallet:',
        error
      );
      return null;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  async disconnect(): Promise<void> {
    this.isIntentionallyClosed = true;
    this.isConnecting = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.connection && this.subscriptionId !== null) {
      try {
        await this.connection.removeAccountChangeListener(this.subscriptionId);
        this.subscriptionId = null;
      } catch (error) {
        console.log('[Solana WebSocket] Error removing listener:', error);
      }
    }

    this.connection = null;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connection !== null;
  }
}

/**
 * Create and manage Solana WebSocket monitor
 */
export function createSolanaWebSocketMonitor(
  config: SolanaWebSocketConfig
): SolanaWebSocketMonitor {
  return new SolanaWebSocketMonitor(config);
}

/**
 * Check if WebSocket is available (browser environment)
 */
export function isWebSocketAvailable(): boolean {
  return typeof window !== 'undefined' || typeof global !== 'undefined';
}

/**
 * Derive Associated Token Account (ATA) address for a wallet and mint
 */
export async function deriveTokenAccountAddress(
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
