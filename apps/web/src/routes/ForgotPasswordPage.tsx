import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Wrapper from "@/components/Wrapper";

const FIELD_CLASS = "mt-2 h-12 rounded-xl border-2 border-brand-blue bg-card";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setUnavailable(false);

    const result = await authClient.requestPasswordReset({ email });
    if (result.error?.status === 503) {
      setIsSubmitting(false);
      setUnavailable(true);
      return;
    }

    // サーバーはメールアドレスが登録済みかどうかを秘匿するため、
    // 存在しないアドレスでも同じ成功レスポンスを返す。
    // ここでエラーを出し分けるとその秘匿が無意味になるので、結果によらず同じ画面を出す。
    setIsSubmitting(false);
    setIsSent(true);
  }

  if (isSent) {
    return (
      <Wrapper>
        <h1 className="text-center text-2xl font-bold">メールを送信しました</h1>
        <p className="mt-6 text-center text-sm">
          {email} が登録されている場合、パスワード再設定用のリンクを送信しました。
          <br />
          メールを確認してリンクを開いてください。
        </p>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          リンクの有効期限は1時間です。
        </p>
        <div className="mt-8 grid">
          <Link
            to="/login"
            className="w-full text-center text-sm font-thin text-brand-blue underline"
          >
            {"<"} ログインに戻る
          </Link>
        </div>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <h1 className="text-center text-2xl font-bold">パスワードの再設定</h1>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        ご登録のメールアドレス宛に、再設定用のリンクを送信します
      </p>
      <form className="mt-8" onSubmit={handleSubmit}>
        {unavailable && (
          <p className="mb-4 text-sm text-destructive">
            現在、アカウント機能の準備中です。しばらくしてからお試しください。
          </p>
        )}
        <div>
          <Label htmlFor="email">
            メールアドレス <span className="ml-1 text-xs text-primary">必須</span>
          </Label>
          <Input
            id="email"
            type="email"
            required
            placeholder="メールアドレスを入力"
            className={FIELD_CLASS}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="mt-8 flex items-center">
          <Button
            className="mx-auto rounded-full px-8 py-2 text-lg"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "送信中..." : "送信する"}
          </Button>
        </div>
        <div className="mt-6 grid">
          <Link
            to="/login"
            className="w-full text-center text-sm font-thin text-brand-blue underline"
          >
            {"<"} ログインに戻る
          </Link>
        </div>
      </form>
    </Wrapper>
  );
}
