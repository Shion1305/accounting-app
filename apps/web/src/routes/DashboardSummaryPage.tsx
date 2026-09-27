import { useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";

import pendingApprovalIcon from "@/components/images/承認待ち.svg";
// import settlementIcon from "@/components/images/立替精算アイコン.svg";
import formatTemplateIcon from "@/components/images/書式フォーマット.svg";
// import expenseEntryIcon from "@/components/images/支出登録アイコン.svg";
// import incomeEntryIcon from "@/components/images/収入登録アイコン.svg";
// import totalIncomeIcon from "@/components/images/総収入アイコン.svg";
// import totalExpenseIcon from "@/components/images/総支出アイコン.svg";
// import transactionsIcon from "@/components/images/取引一覧アイコン.svg";
// import accountingExportIcon from "@/components/images/会計出力アイコン.svg";
// import settingsIcon from "@/components/images/設定アイコン.svg";
// import subscriptionIcon from "@/components/images/サブスク管理アイコン.svg";
// import announcementIcon from "@/components/images/お知らせアイコン.svg";
import linkIcon from "@/components/images/リンクアイコン.svg";
import {
  ArrowCircleUpIcon,
  CheckSquareOffsetIcon,
  CopyIcon,
  GearIcon,
  PlusCircleIcon,
} from "@phosphor-icons/react";

type Circle = { name: string; publicToken: string };

export function DashboardSummaryPage() {
  const { circle } = useOutletContext<{ circle: Circle }>();

  const { data: summary } = useQuery({
    queryKey: ["admin", "summary"],
    queryFn: async () => {
      const res = await apiClient.api.admin.summary.$get();
      if (!res.ok) throw new Error("サマリーの取得に失敗しました");
      return res.json();
    },
  });

  const { data: reimbursements } = useQuery({
    queryKey: ["admin", "reimbursements"],
    queryFn: async () => {
      const res = await apiClient.api.admin.reimbursements.$get();
      if (!res.ok) throw new Error("立替申請の取得に失敗しました");
      return res.json();
    },
  });
  const pendingCount =
    reimbursements?.filter((r) => r.status === "pending").length ?? 0;

  const shareUrl = `${window.location.origin}/#/c/${circle.publicToken}`;

  const [copied, setCopied] = useState(false);

  async function handleCopyShareUrl() {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-2 -mt-8">
      <div className="bg-red-100 rounded-lg p-4">
        <h2 className="font-bold text-xl">立替精算</h2>
        <Link
          to="/dashboard/reimbursements"
          className="flex items-center justify-between rounded-xl border-3 border-destructive/60 bg-card px-4 py-3"
        >
          <img src={pendingApprovalIcon}></img>
          <span className="font-medium">
            立替未精算 <span className="text-destructive">{pendingCount}件</span>
          </span>
          <span className="text-xs text-primary underline">
            承認待ち一覧へ &gt;
          </span>
        </Link>
        <div className="border-brand-blue border-2 rounded-xl px-3 py-3 bg-white gap-2 flex flex-col mt-2">
          <h2 className="flex items-center">
            立替リンク
            <img src={linkIcon} />
          </h2>
          <div className="flex items-center flex-row-reverse border-brand-blue border-2 rounded-md p-1">
            <button
              className=""
              onClick={() => {
                handleCopyShareUrl();
              }}
            >
              {!copied?<CopyIcon className="size-6 text-brand-blue" weight="fill" />:<CheckSquareOffsetIcon className="size-6 text-brand-blue" />}
            </button>
            <div className="text-xs text-nowrap overflow-hidden ml-2 font-bold">{shareUrl}</div>
          </div>
        </div>
      </div>
      <div className="bg-blue-100 rounded-lg p-4">
        <h2 className="text-xl font-bold">会計管理</h2>
        <div className="">
          <p className="text-sm bg-brand-blue rounded-t-lg px-6 py-2 text-white">
            〇〇年度
          </p>
          <div className="border-x-2 border-b-2 border-brand-blue rounded-b-lg bg-white p-2">
            <div className="flex gap-6">
              <ArrowCircleUpIcon
                size={32}
                weight="fill"
                className="fill-brand-blue size-12"
              />
              <div>
                <p className="text-xl font-bold">収支</p>
                <p className="font-bold text-green-500">{summary ? `¥${summary.balance.toLocaleString()}` : "-"}</p>
              </div>
              {/* <img src={totalIncomeIcon} /> */}
            </div>
              <div className="flex flex-row-reverse">
                  <Link to={"/dashboard/transactions"}>
                <button className="bg-brand-blue rounded-full text-white text-xs py-1 px-6">
                  詳細へ&gt;
                </button>
                  </Link>
              </div>
          </div>
          <Link
            to="#"
            className="border-green-500 border-2 rounded-xl px-4 py-2 bg-white flex items-center gap-2 m-2"
          >
            <img src={formatTemplateIcon}></img>
            <p className="font-bold text-sm">会計出力（未実装）</p>
            <p className="text-xs">登録した大学書式</p>
            <p className="text-brand-green font-bold text-xl"> &gt;</p>
          </Link>
          <div className="grid gap-2 grid-cols-2">
            <Button
              asChild
              className="rounded-xl bg-brand-blue text-white hover:bg-brand-blue"
            >
              <Link to="/dashboard/expenses" className="flex">
                {/* <img src={expenseEntryIcon} className="size-8" /> */}
                <PlusCircleIcon size={32} className="size-8 fill-white" weight="fill" />
                支出登録
              </Link>
            </Button>
            <Button
              asChild
              className="rounded-xl bg-[#00BB5C] text-white hover:bg-[#00BB5C]"
            >
              <Link to="/dashboard/income" className="flex">
                {/* <img src={incomeEntryIcon} /> */}
                <PlusCircleIcon size={32} className="size-8 fill-white" weight="fill" />
                収入登録
              </Link>
            </Button>
          </div>
          <Button
            asChild
            variant="outline"
            className="rounded-xl border-brand-blue text-brand-blue hover:text-brand-blue"
          >
            <Link to="/dashboard/setting" className="mt-2 w-full">
              {/* <img src={settingsIcon} /> */}
              <GearIcon size={32} className="size-6" />
              <p className="font-bold text-black">設定</p>
              <p className="text-xs text-black">登録情報や会計書式の変更など</p>
              <p className="text-xl">&gt;</p>
            </Link>
          </Button>
        </div>
      </div>

      <div>
        <div className="grid grid-cols-3 gap-2"></div>
      </div>

      <ul className="list-disc list-inside marker:text-brand-blue">
        <li className="">
          <Link className="" to={"/rule"}>
            特定商取引法に基づく表記{"   "}
            <span className="text-brand-blue">&gt;</span>
          </Link>
        </li>
        <li className="">
          <Link className="" to={"/rule"}>
            利用規約{"   "}
            <span className="text-brand-blue">&gt;</span>
          </Link>
        </li>
        <li className="">
          <Link className="" to={"/rule"}>
            プライバシーポリシー{"   "}
            <span className="text-brand-blue">&gt;</span>
          </Link>
        </li>
      </ul>
    </div>
  );
}
