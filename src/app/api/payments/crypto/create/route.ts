import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { prisma } from '@/lib/db';
import { convertFiatToCrypto } from '@/lib/crypto/coingecko';
import { getCryptoAddress } from '@/lib/crypto/address-management';
import { calculateInvoiceTotals } from '@/lib/invoice-calculations';
import { getInvoiceCurrency } from '@/lib/currency';
import { isTestMode, isTestnetEnabled } from '@/lib/crypto/blockchain-monitor';
import {
  getTokenAccountAddress,
  getMintAddress
} from '@/lib/crypto/solana-utils';

export async function POST(request: NextRequest) {
  try {
    // Get auth, but don't require it (allow guest access via share links)
    let orgId: string | null = null;
    try {
      const authResult = await auth();
      // Only set orgId if it's a valid non-empty string
      if (
        authResult?.orgId &&
        typeof authResult.orgId === 'string' &&
        authResult.orgId.length > 0
      ) {
        orgId = authResult.orgId;
      } else {
        orgId = null;
      }
    } catch (error) {
      // User is not authenticated (guest access) - this is allowed for share links
      orgId = null;
    }

    const body = await request.json();
    const { invoiceId, cryptocurrency, amount } = body;

    if (!invoiceId || !cryptocurrency) {
      return NextResponse.json(
        { error: 'Invoice ID and cryptocurrency are required' },
        { status: 400 }
      );
    }

    // Get invoice - don't filter by orgId yet, we'll check access below
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: true,
        payments: true,
        organization: true,
        customer: true
      }
    });

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Check access permissions (similar to Stripe endpoints)
    // Priority: If invoice has shareToken, allow access regardless of auth status
    const hasShareToken = !!invoice.shareToken;
    const isAuthenticated =
      orgId && typeof orgId === 'string' && orgId.length > 0;

    if (hasShareToken) {
      // Invoice has shareToken - allow access (guest or authenticated)
      // Use invoice's organizationId
      orgId = invoice.organizationId;
    } else if (isAuthenticated) {
      // Authenticated user accessing invoice without shareToken - must belong to their org
      if (invoice.organizationId !== orgId) {
        return NextResponse.json(
          {
            error: 'Invoice not found or does not belong to your organization'
          },
          { status: 404 }
        );
      }
    } else {
      // Guest user trying to access invoice without shareToken
      return NextResponse.json(
        {
          error:
            'This invoice is not publicly accessible. Please use the share link provided in the invoice email.'
        },
        { status: 403 }
      );
    }

    // Now we have orgId (either from auth or from invoice)
    if (!orgId) {
      return NextResponse.json(
        { error: 'Organization not found' },
        { status: 404 }
      );
    }

    // Check if crypto payments are enabled
    if (!invoice.organization.cryptoPaymentsEnabled) {
      return NextResponse.json(
        { error: 'Crypto payments are not enabled for this organization' },
        { status: 400 }
      );
    }

    // Calculate invoice total
    const invoiceTotals = calculateInvoiceTotals(invoice as any);
    const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
    const remainingBalance = invoiceTotals.balance;

    // Ensure we don't exceed remaining balance
    if (remainingBalance <= 0) {
      return NextResponse.json(
        { error: 'Invoice is already fully paid' },
        { status: 400 }
      );
    }

    // Use provided amount or remaining balance, but always cap at remaining balance
    let paymentAmount = amount ? parseFloat(String(amount)) : remainingBalance;

    // Cap payment amount to remaining balance (with small rounding tolerance for floating point)
    const maxAllowedAmount = remainingBalance + 0.01; // Allow 1 cent tolerance for rounding
    if (paymentAmount > maxAllowedAmount) {
      // If significantly over, warn but still cap it
      if (paymentAmount > remainingBalance + 1) {
        console.warn(
          `Payment amount ($${paymentAmount.toFixed(2)}) exceeds remaining balance ($${remainingBalance.toFixed(2)}). Capping to remaining balance.`
        );
      }
      // Always cap to remaining balance to prevent overpayment
      paymentAmount = remainingBalance;
    }

    if (paymentAmount <= 0) {
      return NextResponse.json(
        { error: 'Payment amount must be greater than 0' },
        { status: 400 }
      );
    }

    // Get currency
    const currency = getInvoiceCurrency(invoice);

    // Convert fiat to crypto
    const { cryptoAmount, exchangeRate } = await convertFiatToCrypto(
      paymentAmount,
      currency,
      cryptocurrency
    );

    // Get crypto address
    // For Solana tokens (USDC, USDT, SOL), we need to derive the Associated Token Account (ATA)
    const crypto = cryptocurrency.toLowerCase();
    const isSolanaToken =
      crypto === 'usdc' || crypto === 'usdt' || crypto === 'sol';

    let address: string;
    let destinationTag: number | null = null;

    let walletAddress: string | undefined;
    if (isSolanaToken) {
      // Get the wallet address
      walletAddress = await getCryptoAddress(orgId, cryptocurrency);

      if (crypto === 'sol') {
        // For native SOL, use the wallet address directly (not token account)
        address = walletAddress;
      } else {
        // For USDC/USDT, derive the token account address
        const mintAddress = getMintAddress(cryptocurrency, isTestnetEnabled());
        address = await getTokenAccountAddress(walletAddress, mintAddress);
      }
    } else {
      // For other cryptos (XRP, etc.), use the address directly
      address = await getCryptoAddress(orgId, cryptocurrency);

      // Generate destination tag for XRP (unique identifier for this payment)
      // XRP destination tags are 32-bit unsigned integers (0 to 4294967295)
      // This allows multiple invoices to use the same address
      const isXRP = crypto === 'xrp';
      destinationTag = isXRP
        ? Math.floor(Math.random() * 2147483647) // Max safe XRP destination tag
        : null;
    }

    // Set expiration (24 hours from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // Get minimum confirmations
    const minConfirmations = invoice.organization.cryptoMinConfirmations || 3;

    // Create payment record with amount = 0 initially
    // This payment will NOT appear in the payments list until a transaction is detected
    // The amount will be updated to the actual received amount when transaction is confirmed
    const payment = await prisma.payment.create({
      data: {
        invoiceId,
        amount: 0, // Set to 0 initially - will be updated when transaction is detected
        expectedAmount: paymentAmount, // Store expected amount for comparison
        date: new Date(),
        method: `crypto_${cryptocurrency.toLowerCase()}`,
        notes: `Crypto payment pending: ${cryptoAmount} ${cryptocurrency.toUpperCase()} - Waiting for transaction...`
      } as any // Type assertion needed until Prisma client is regenerated
    });

    // Create crypto payment record
    const cryptoPayment = await prisma.cryptoPayment.create({
      data: {
        paymentId: payment.id,
        organizationId: orgId,
        cryptocurrencyCode: cryptocurrency.toLowerCase(),
        amount: cryptoAmount, // Expected crypto amount
        address,
        destinationTag, // XRP destination tag for payment identification
        minConfirmations,
        status: 'pending',
        expiresAt,
        exchangeRate,
        fiatAmount: paymentAmount, // Will be updated with actual fiat amount when transaction is detected
        expectedFiatAmount: paymentAmount, // Store expected fiat amount for comparison
        fiatCurrency: currency
      } as any, // Type assertion needed until Prisma client is regenerated
      include: {
        payment: {
          include: {
            invoice: true
          }
        }
      }
    });

    // Generate QR code data
    // For XRP, include destination tag in QR code
    // For Solana, we can use Solana Pay format or simple address format
    let qrCodeData: string;
    if (isSolanaToken) {
      // Use Solana Pay format: solana:<address>?amount=<amount>&spl-token=<mint>
      const mintAddress = getMintAddress(cryptocurrency, isTestnetEnabled());
      qrCodeData = `solana:${address}?amount=${cryptoAmount}&spl-token=${mintAddress}`;
    } else if (crypto === 'xrp' && destinationTag !== null) {
      qrCodeData = `${cryptocurrency.toLowerCase()}:${address}?dt=${destinationTag}&amount=${cryptoAmount}`;
    } else {
      qrCodeData = `${cryptocurrency.toLowerCase()}:${address}?amount=${cryptoAmount}`;
    }

    return NextResponse.json({
      paymentId: payment.id,
      cryptoPaymentId: cryptoPayment.id,
      cryptocurrency: cryptocurrency.toUpperCase(),
      cryptoAmount,
      address,
      walletAddress: walletAddress || undefined, // Include wallet address for native SOL monitoring
      destinationTag, // Include in response for display
      qrCode: qrCodeData,
      expiresAt: expiresAt.toISOString(),
      minConfirmations,
      exchangeRate,
      fiatAmount: paymentAmount,
      fiatCurrency: currency,
      testMode: isTestMode(),
      testnet: isTestnetEnabled()
    });
  } catch (error: any) {
    console.error('Error creating crypto payment:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create crypto payment' },
      { status: 500 }
    );
  }
}
