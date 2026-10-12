import { Link, Route, Routes } from "react-router-dom";
import { RequireAuth } from "@/components/RequireAuth";
import { AdminLayout } from "@/routes/AdminLayout";
import { DashboardSummaryPage } from "@/routes/DashboardSummaryPage";
import { ExpenseAdminPage } from "@/routes/ExpenseAdminPage";
import { IncomeAdminPage } from "@/routes/IncomeAdminPage";
import { OnboardingPage } from "@/routes/OnboardingPage";
import { ReimbursementSubmitPage } from "@/routes/ReimbursementSubmitPage";
import { ReimbursementsAdminPage } from "@/routes/ReimbursementsAdminPage";
import { SignInPage } from "@/routes/SignInPage";
import { SignUpPage } from "@/routes/SignUpPage";
import Header from "./components/Header";

function HomePage() {
  return (
    <div>
        <Header/>
      <div className="flex flex-col items-start gap-2 p-8">
        <p>サークル会計アプリ（セットアップ中）</p>
        <Link to="/signup" className="underline">
          新規登録
        </Link>
        <Link to="/login" className="underline">
          ログイン
        </Link>
      </div>
    </div>
  );
}

export function App() {
  return (
    <div className="font-mono">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/login" element={<SignInPage />} />
        <Route path="/c/:token" element={<ReimbursementSubmitPage />} />
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
          <Route path="reimbursements" element={<ReimbursementsAdminPage />} />
          <Route path="income" element={<IncomeAdminPage />} />
          <Route path="expenses" element={<ExpenseAdminPage />} />
        </Route>
      </Routes>
    </div>
  );
}
