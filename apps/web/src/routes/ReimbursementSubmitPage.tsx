import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 10MB

export function ReimbursementSubmitPage() {
  const { token } = useParams<{ token: string }>();

  const { data: circle, isPending: isCirclePending } = useQuery({
    queryKey: ["public-circle", token],
    queryFn: async () => {
      const res = await apiClient.api.public.circles[":token"].$get({
        param: { token: token! },
      });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: Boolean(token),
  });

  const [payerName, setPayerName] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size > MAX_RECEIPT_BYTES) {
      setError("レシート画像は10MB以内にしてください");
      setReceipt(null);
      event.target.value = "";
      return;
    }
    setError(null);
    setReceipt(file);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!receipt) {
      setError("レシート画像を選択してください");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const formData = new FormData();
    formData.set("payerName", payerName);
    formData.set("amount", amount);
    formData.set("memo", memo);
    formData.set("receipt", receipt);

    const res = await fetch(
      `${import.meta.env.VITE_API_URL || ""}/api/public/circles/${token}/reimbursements`,
      { method: "POST", body: formData },
    );

    setIsSubmitting(false);

    if (!res.ok) {
      setError("申請に失敗しました。入力内容をご確認ください。");
      return;
    }

    setIsSubmitted(true);
  }

  if (isCirclePending) {
    return null;
  }

  if (!circle) {
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>URLが正しくありません</CardTitle>
            <CardDescription>共有URLをもう一度ご確認ください。</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (isSubmitted) {
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>申請を受け付けました</CardTitle>
            <CardDescription>管理者の承認をお待ちください。</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>立替申請</CardTitle>
          <CardDescription>{circle.name}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="payer-name">支払者</Label>
              <Input
                id="payer-name"
                required
                value={payerName}
                onChange={(e) => setPayerName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="amount">金額(円)</Label>
              <Input
                id="amount"
                type="number"
                min={1}
                step={1}
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="receipt">レシート画像(10MBまで)</Label>
              <Input
                id="receipt"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                required
                onChange={handleFileChange}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="memo">メモ</Label>
              <Input id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "送信中..." : "申請する"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
