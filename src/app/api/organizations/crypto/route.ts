import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { prisma } from '@/lib/db';
import {
  createXRPAccount,
  generateXRPWallet
} from '@/lib/crypto/xrp-account-generator';
import {
  createSolanaAccount,
  generateSolanaWallet
} from '@/lib/crypto/solana-account-generator';
import { addCryptoAddress } from '@/lib/crypto/address-management';
import { isTestnetEnabled } from '@/lib/crypto/blockchain-monitor';

export async function GET(request: NextRequest) {
  try {
    const { orgId } = await auth();

    if (!orgId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const organization = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        cryptoPaymentsEnabled: true,
        cryptoWallets: true,
        cryptoMinConfirmations: true,
        stopReusingAddresses: true,
        addressReuseCooldownHours: true
      }
    });

    if (!organization) {
      return NextResponse.json(
        { error: 'Organization not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(organization);
  } catch (error: any) {
    console.error('Error fetching crypto settings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch crypto settings' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { orgId } = await auth();

    if (!orgId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      cryptoPaymentsEnabled,
      cryptoMinConfirmations,
      stopReusingAddresses,
      addressReuseCooldownHours,
      xrpAddresses,
      usdcAddresses,
      usdtAddresses,
      solAddresses
    } = body;

    // Build crypto wallets JSON
    const cryptoWallets: Record<string, string[]> = {};
    if (xrpAddresses && Array.isArray(xrpAddresses)) {
      cryptoWallets.xrp = xrpAddresses.filter((addr: string) => addr.trim());
    }
    if (usdcAddresses && Array.isArray(usdcAddresses)) {
      cryptoWallets.usdc = usdcAddresses.filter((addr: string) => addr.trim());
    }
    if (usdtAddresses && Array.isArray(usdtAddresses)) {
      cryptoWallets.usdt = usdtAddresses.filter((addr: string) => addr.trim());
    }
    if (solAddresses && Array.isArray(solAddresses)) {
      cryptoWallets.sol = solAddresses.filter((addr: string) => addr.trim());
    }

    // Update organization
    const organization = await prisma.organization.update({
      where: { id: orgId },
      data: {
        cryptoPaymentsEnabled: cryptoPaymentsEnabled ?? false,
        cryptoMinConfirmations: cryptoMinConfirmations ?? 3,
        stopReusingAddresses: stopReusingAddresses ?? false,
        addressReuseCooldownHours: addressReuseCooldownHours ?? 24,
        cryptoWallets:
          Object.keys(cryptoWallets).length > 0
            ? JSON.stringify(cryptoWallets)
            : null
      }
    });

    return NextResponse.json({
      success: true,
      organization: {
        cryptoPaymentsEnabled: organization.cryptoPaymentsEnabled,
        cryptoWallets: organization.cryptoWallets,
        cryptoMinConfirmations: organization.cryptoMinConfirmations,
        stopReusingAddresses: organization.stopReusingAddresses,
        addressReuseCooldownHours: organization.addressReuseCooldownHours
      }
    });
  } catch (error: any) {
    console.error('Error updating crypto settings:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to update crypto settings' },
      { status: 500 }
    );
  }
}

/**
 * Generate a new crypto account and add it to the organization
 * POST /api/organizations/crypto
 *
 * Supports:
 * - XRP: Generates XRP receiving address for invoice payments
 * - Solana tokens (USDC, USDT, SOL): Generates Solana wallet address
 */
export async function POST(request: NextRequest) {
  try {
    const { orgId } = await auth();

    if (!orgId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { useFaucet, cryptocurrency } = body;

    const isTestnet = isTestnetEnabled();

    // Handle XRP account generation
    if (!cryptocurrency || cryptocurrency.toLowerCase() === 'xrp') {
      let account;
      if (useFaucet && isTestnet) {
        account = await createXRPAccount(true);
      } else {
        account = generateXRPWallet();
      }

      await addCryptoAddress(orgId, 'xrp', account.address);

      return NextResponse.json({
        success: true,
        account: {
          address: account.address,
          seed: account.seed,
          balance: account.balance || '0',
          funded: !!account.balance && account.balance !== '0'
        },
        warning: isTestnet
          ? 'This is a testnet account. Save the seed securely if you want to reuse this account.'
          : 'This account is not funded. You must fund it manually before using it for payments.'
      });
    }

    // Handle Solana account generation (USDC, USDT, SOL)
    const crypto = cryptocurrency.toLowerCase();
    if (['usdc', 'usdt', 'sol'].includes(crypto)) {
      let account;
      let fundingError: string | null = null;

      if (useFaucet && isTestnet) {
        try {
          // Request 1 SOL for testnet (enough for transaction fees)
          account = await createSolanaAccount(true, 1);
        } catch (error: any) {
          // If faucet fails, generate unfunded account and inform user
          console.warn(
            '[Solana] Faucet request failed, generating unfunded account:',
            error.message
          );
          account = await generateSolanaWallet();
          fundingError = error.message;
        }
      } else {
        account = await generateSolanaWallet();
      }

      // Add the address to the organization
      await addCryptoAddress(orgId, crypto, account.address);

      return NextResponse.json({
        success: true,
        account: {
          address: account.address,
          privateKey: account.privateKey, // Base58 encoded secret key
          balance: account.balance || '0',
          funded: !!account.balance && account.balance !== '0'
        },
        warning: fundingError
          ? `Account generated but faucet funding failed: ${fundingError}. You can fund this account manually using a Solana wallet.`
          : isTestnet
            ? 'This is a testnet account. Save the private key securely if you want to reuse this account.'
            : 'This account is not funded. You must fund it manually before using it for payments.'
      });
    }

    return NextResponse.json(
      { error: `Unsupported cryptocurrency: ${cryptocurrency}` },
      { status: 400 }
    );
  } catch (error: any) {
    console.error('Error generating account:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate account' },
      { status: 500 }
    );
  }
}
