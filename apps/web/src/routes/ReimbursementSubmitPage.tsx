import { useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Wrapper from "@/components/Wrapper";
import photoIcon from "@/components/images/photo_Icon.svg";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 10MB

export function ReimbursementSubmitPage() {
  const { token } = useParams<{ token: string }>();
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const [title, setTitle] = useState("");
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
    formData.set("title", title);
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
      <Wrapper>
        <h1 className="text-center text-2xl font-bold">URLが正しくありません</h1>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          共有URLをもう一度ご確認ください。
        </p>
      </Wrapper>
    );
  }

  if (isSubmitted) {
    return (
      <Wrapper>
        <h1 className="text-center text-2xl font-bold">申請を受け付けました</h1>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          管理者の承認をお待ちください。
        </p>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <h1 className="text-center text-2xl font-bold">{circle.name}</h1>
      <form className="mt-8" onSubmit={handleSubmit}>
        <div>
          <Label htmlFor="title">
            件名 <span className="ml-1 text-xs text-primary">必須</span>
          </Label>
          <Input
            id="title"
            required
            placeholder="テキストを入力"
            className="mt-2 h-12 rounded-xl border-2 border-brand-blue"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="payer-name">
            支払者 <span className="ml-1 text-xs text-primary">必須</span>
          </Label>
          <Input
            id="payer-name"
            required
            placeholder="テキストを入力"
            className="mt-2 h-12 rounded-xl border-2 border-brand-blue"
            value={payerName}
            onChange={(e) => setPayerName(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="amount">
            金額 <span className="ml-1 text-xs text-primary">必須</span>
          </Label>
          <Input
            id="amount"
            type="number"
            min={1}
            step={1}
            required
            placeholder="¥0"
            className="mt-2 h-12 rounded-xl border-2 border-brand-blue"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="receipt">
            レシート画像アップロード <span className="ml-1 text-xs text-muted-foreground">任意</span>
          </Label>
          <input
            ref={fileInputRef}
            id="receipt"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-blue/60 text-sm font-medium text-white"
          >
            <img src={photoIcon} alt="" className="size-5" />
            {receipt ? receipt.name : "ファイルを選択"}
          </button>
        </div>
        <div className="mt-6">
          <Label htmlFor="memo">
            メモ <span className="ml-1 text-xs text-muted-foreground">任意</span>
          </Label>
          <textarea
            id="memo"
            placeholder="テキストを入力"
            className="mt-2 min-h-32 w-full rounded-xl border-2 border-brand-blue bg-transparent px-3 py-2 text-sm outline-none"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <div className="mt-8 flex items-center">
          <Button
            className="mx-auto rounded-full px-8 py-2 text-lg"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "送信中..." : "立替申請"}
          </Button>
        </div>
      </form>
    </Wrapper>
  );
}
