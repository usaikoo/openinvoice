import { prisma } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { sendInvoiceEmail } from '@/lib/email';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * POST - Manually generate an invoice from a recurring template
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { orgId } = await auth();

    if (!orgId) {
      return NextResponse.json(
        { error: 'Unauthorized - Organization required' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Get the template
    const template = await prisma.recurringInvoiceTemplate.findFirst({
      where: { id, organizationId: orgId },
      include: {
        customer: true,
        organization: true
      }
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Recurring invoice template not found' },
        { status: 404 }
      );
    }

    if (template.status !== 'active') {
      return NextResponse.json(
        { error: 'Template is not active. Cannot generate invoice.' },
        { status: 400 }
      );
    }

    // Parse template items
    const items = JSON.parse(template.templateItems);

    // Calculate dates
    const issueDate = new Date();
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + template.daysUntilDue);

    // Generate invoice using the same logic as regular invoice creation
    const invoice = await prisma.$transaction(
      async (tx) => {
        // Atomically increment counter
        const counter = await tx.invoiceCounter.upsert({
          where: { organizationId: orgId },
          update: { lastInvoiceNo: { increment: 1 } },
          create: { organizationId: orgId, lastInvoiceNo: 1 }
        });

        // Create invoice
        return await tx.invoice.create({
          data: {
            invoiceNo: counter.lastInvoiceNo,
            customerId: template.customerId,
            organizationId: orgId,
            dueDate,
            issueDate,
            status: template.autoSendEmail ? 'sent' : 'draft',
            notes: template.templateNotes || null,
            recurringTemplateId: template.id,
            items: {
              create: items.map((item: any) => ({
                productId: item.productId,
                description: item.description,
                quantity: parseInt(item.quantity),
                price: parseFloat(item.price),
                taxRate: item.taxRate ? parseFloat(item.taxRate) : 0
              }))
            }
          },
          include: {
            customer: true,
            items: {
              include: {
                product: true
              }
            }
          }
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 5000,
        timeout: 10000
      }
    );

    // Generate share token
    const shareToken = randomBytes(32).toString('base64url');
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { shareToken }
    });

    // Send email if auto-send is enabled
    if (template.autoSendEmail && template.customer.email) {
      try {
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        const invoiceUrl = `${baseUrl}/invoice/${shareToken}`;
        const pdfUrl = `${baseUrl}/api/invoices/${invoice.id}/pdf`;

        // Calculate totals
        const subtotal = invoice.items.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0
        );
        const tax = invoice.items.reduce(
          (sum, item) =>
            sum + item.price * item.quantity * (item.taxRate / 100),
          0
        );
        const total = subtotal + tax;

        await sendInvoiceEmail({
          to: template.customer.email,
          customerName: template.customer.name,
          invoiceNo: invoice.invoiceNo,
          invoiceUrl,
          pdfUrl,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
          total,
          organizationName: template.organization?.name
        });

        // Log the email
        await prisma.emailLog.create({
          data: {
            invoiceId: invoice.id,
            emailType: 'invoice',
            recipient: template.customer.email,
            status: 'sent'
          }
        });
      } catch (emailError) {
        console.error('Error sending invoice email:', emailError);
        // Don't fail the whole operation if email fails
      }
    }

    // Calculate next generation date
    const nextGenDate = calculateNextGenerationDate(
      template.frequency,
      template.interval,
      issueDate
    );

    // Check if we've reached the end date
    let newStatus = template.status;
    if (template.endDate && nextGenDate > template.endDate) {
      newStatus = 'completed';
    }

    // Update template
    await prisma.recurringInvoiceTemplate.update({
      where: { id },
      data: {
        nextGenerationDate: nextGenDate,
        lastGeneratedAt: issueDate,
        totalGenerated: { increment: 1 },
        status: newStatus
      }
    });

    return NextResponse.json({
      success: true,
      invoice,
      message: 'Invoice generated successfully'
    });
  } catch (error) {
    console.error('Error generating invoice from template:', error);

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return NextResponse.json(
          { error: 'Invoice number conflict. Please try again.' },
          { status: 409 }
        );
      }
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to generate invoice'
      },
      { status: 500 }
    );
  }
}

/**
 * Calculate the next generation date based on frequency
 */
function calculateNextGenerationDate(
  frequency: string,
  interval: number,
  currentDate: Date
): Date {
  const nextDate = new Date(currentDate);

  switch (frequency) {
    case 'daily':
      nextDate.setDate(nextDate.getDate() + interval);
      break;
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7 * interval);
      break;
    case 'biweekly':
      nextDate.setDate(nextDate.getDate() + 14 * interval);
      break;
    case 'monthly':
      nextDate.setMonth(nextDate.getMonth() + interval);
      break;
    case 'quarterly':
      nextDate.setMonth(nextDate.getMonth() + 3 * interval);
      break;
    case 'yearly':
      nextDate.setFullYear(nextDate.getFullYear() + interval);
      break;
    case 'custom':
      // For custom, interval is in days
      nextDate.setDate(nextDate.getDate() + interval);
      break;
    default:
      // Default to monthly
      nextDate.setMonth(nextDate.getMonth() + 1);
  }

  return nextDate;
}
