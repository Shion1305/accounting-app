import { Link, Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/components/RequireAuth";
import Wrapper from "@/components/Wrapper";
import { AdminLayout } from "@/routes/AdminLayout";
import { AccountingExportPage } from "@/routes/AccountingExportPage";
import { DashboardSummaryPage } from "@/routes/DashboardSummaryPage";
import { ExpenseAdminPage } from "@/routes/ExpenseAdminPage";
import { ForgotPasswordPage } from "@/routes/ForgotPasswordPage";
import { IncomeAdminPage } from "@/routes/IncomeAdminPage";
import { ResetPasswordPage } from "@/routes/ResetPasswordPage";
import { OnboardingPage } from "@/routes/OnboardingPage";
import { ReimbursementSubmitPage } from "@/routes/ReimbursementSubmitPage";
import { ReimbursementsAdminPage } from "@/routes/ReimbursementsAdminPage";
import { SignInPage } from "@/routes/SignInPage";
import { SignUpPage } from "@/routes/SignUpPage";
import SettingAdminPage from "./routes/SettingAdminPage";
import SubscriptionAdminPage from "./routes/SubscriptionAdminPage";
import TransactionsAdminPage from "./routes/TransactionsAdminPage";
import LiquidationAdminPage from "./routes/LiquidationAdminPage";
import RulePage from "./routes/RulePage"
import PublicTokenAdminPage from "./routes/PublicTokenAdminPage";

function HomePage() {
  return (
    <Wrapper>
      <div className="flex flex-col items-start gap-2">
        <p>サークル会計アプリ（セットアップ中）</p>
        <Link to="/signup" className="underline">
          新規登録
        </Link>
        <Link to="/login" className="underline">
          ログイン
        </Link>
      </div>
    </Wrapper>
  );
}

export function App() {
  return (
    <div className="font-mono">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/login" element={<SignInPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/c/:token" element={<ReimbursementSubmitPage />} />
        <Route path="/rule" element={<RulePage/>}/>
        <Route
          path="/onboarding"
          element={
            <RequireAuth>
              <OnboardingPage />
            </RequireAuth>
          }
        />
        <Route
          path="/dashboard"
          element={
            <RequireAuth>
              <AdminLayout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardSummaryPage />} />
          <Route path="accounting-export" element={<AccountingExportPage />} />
          <Route path="reimbursements" element={<ReimbursementsAdminPage />} />
          <Route path="income" element={<IncomeAdminPage />} />
          <Route path="expenses" element={<ExpenseAdminPage />} />
          <Route path="setting" element={<SettingAdminPage />} />
          <Route path="subscription" element={<SubscriptionAdminPage />} />
          <Route path="transactions" element={<TransactionsAdminPage />} />
          <Route path="liquidation" element={<LiquidationAdminPage/>}/>
          <Route path="publicToken" element={<PublicTokenAdminPage/>}/>
        </Route>
      </Routes>
    </div>
  );
}
