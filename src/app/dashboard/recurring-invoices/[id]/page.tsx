import PageContainer from '@/components/layout/page-container';
import { RecurringInvoiceView } from '@/features/invoicing/components/recurring-invoice-view';

export const metadata = {
  title: 'Dashboard: Recurring Invoice Details'
};

export default function RecurringInvoiceDetailsPage() {
  return (
    <PageContainer
      pageTitle='Recurring Invoice Template'
      pageDescription='View and manage recurring invoice template details'
    >
      <RecurringInvoiceView />
    </PageContainer>
  );
}
