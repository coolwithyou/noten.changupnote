import { BillingPageView } from "@/features/billing/BillingPageView";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";
import { fallbackHeaderUserForDemoAccess, getOptionalWebSession } from "@/lib/server/auth/session";
import { buildBillingReadiness } from "@/lib/server/billing/billingReadiness";
import { listBillingInvoices } from "@/lib/server/billing/invoices";
import { listBillingPaymentMethods } from "@/lib/server/billing/paymentMethods";
import { listBillingPlanRequestHistory } from "@/lib/server/billing/planRequestHistory";
import { listBillingTaxDocuments } from "@/lib/server/billing/taxDocuments";
import { loadBillingTaxProfile } from "@/lib/server/billing/taxProfile";
import { loadWorkspaceOverview } from "@/lib/server/workspace/overview";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const access = await loadBillingAccess();
  const session = await getOptionalWebSession();
  const [overview, planRequests, invoices, paymentMethods, taxProfile, taxDocuments] = await Promise.all([
    loadWorkspaceOverview({ access, session }),
    listBillingPlanRequestHistory({ access, session }),
    listBillingInvoices({ access, limit: 10 }),
    listBillingPaymentMethods({ access, limit: 10 }),
    loadBillingTaxProfile({ access, session }),
    listBillingTaxDocuments({ access, limit: 10 }),
  ]);
  const readiness = buildBillingReadiness({ overview, planRequests, taxDocuments });
  return (
    <BillingPageView
      overview={overview}
      planRequests={planRequests}
      invoices={invoices}
      paymentMethods={paymentMethods}
      taxProfile={taxProfile}
      taxDocuments={taxDocuments}
      readiness={readiness}
      user={headerUser(session) ?? fallbackHeaderUserForDemoAccess(access)}
    />
  );
}

async function loadBillingAccess() {
  try {
    return await requireCompanyAccess();
  } catch (error) {
    redirectOnAuthRequired(error, "/billing");
  }
}

function headerUser(session: Awaited<ReturnType<typeof getOptionalWebSession>>) {
  if (!session) return null;
  return {
    name: session.user.name ?? null,
    email: session.user.email ?? null,
  };
}
