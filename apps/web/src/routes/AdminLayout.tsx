import { Navigate, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import Wrapper from "@/components/Wrapper";

export function AdminLayout() {
  const navigate = useNavigate();

  const { data: circle, isPending } = useQuery({
    queryKey: ["circles", "me"],
    queryFn: async () => {
      const res = await apiClient.api.circles.me.$get();
      if (!res.ok) throw new Error("サークル情報の取得に失敗しました");
      return res.json();
    },
  });

  async function handleSignOut() {
    await authClient.signOut();
    void navigate("/login");
  }

  if (isPending) return null;
  if (!circle) return <Navigate to="/onboarding" replace />;

  return (
    <Wrapper
      menuItems={[
        { label: "サマリー", to: "/dashboard" },
        { label: "立替申請の承認", to: "/dashboard/reimbursements" },
        { label: "収入登録", to: "/dashboard/income" },
        { label: "支出登録", to: "/dashboard/expenses" },
        {label:"収支一覧",to:"/dashboard/transactions"},
        { label: "会計書類の作成", to: "/dashboard/accounting-export" },
        { label: "設定", to: "/dashboard/setting" },
        { label: "サブスク管理", to: "/dashboard/subscription" },
        { label: "ログアウト", onClick: handleSignOut },
      ]}
    >
      {/* <h1 className="text-center text-2xl font-bold">{circle.name}</h1> */}
      <div className="mt-8">
        <Outlet context={{ circle }} />
      </div>
    </Wrapper>
  );
}
