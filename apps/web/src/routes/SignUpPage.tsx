import { useState, type FormEvent } from "react";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Wrapper from "@/components/Wrapper";
import { Link } from "react-router-dom";
import { Checkbox } from "@/components/ui/checkbox";

const FIELD_CLASS = "mt-2 h-12 rounded-xl border-2 border-brand-blue bg-card";

function RequiredBadge() {
  return <span className="ml-1 text-xs text-primary">必須</span>;
}

export function SignUpPage() {
  const [circleName, setCircleName] = useState("");
  const [universityName, setUniversityName] = useState("");
  const [representativeName, setRepresentativeName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSent, setIsSent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== passwordConfirm) {
      setError("パスワードが一致しません");
      return;
    }

    setIsSubmitting(true);

    const res = await apiClient.api.signup.$post({
      json: {
        circleName,
        universityName,
        representativeName,
        phoneNumber,
        email,
        password,
      },
    });

    setIsSubmitting(false);

    if (!res.ok) {
      setError(res.status === 503
        ? "現在、アカウント機能の準備中です。しばらくしてからお試しください。"
        : "登録に失敗しました。入力内容をご確認ください。");
      return;
    }

    setIsSent(true);
  }

  if (isSent) {
    return (
      <Wrapper>
        <h1 className="text-center text-2xl font-bold">確認メールを送信しました</h1>
        <p className="mt-6 text-center text-sm">
          {email} 宛てにメールを送信しました。
          <br />
          メール内のリンクを開いて登録を完了してください。
        </p>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <h1 className="text-center text-2xl font-bold">新規登録</h1>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        お使いのメールアドレス宛に確認メールを送信します
      </p>
      <form className="mt-8" onSubmit={handleSubmit}>
        <div>
          <Label htmlFor="circle-name">
            サークル名 <RequiredBadge />
          </Label>
          <Input
            id="circle-name"
            required
            placeholder="テキストを入力"
            className={FIELD_CLASS}
            value={circleName}
            onChange={(e) => setCircleName(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="university-name">
            大学名 <RequiredBadge />
          </Label>
          <Input
            id="university-name"
            required
            placeholder="テキストを入力"
            className={FIELD_CLASS}
            value={universityName}
            onChange={(e) => setUniversityName(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="representative-name">
            サークル代表者名 <RequiredBadge />
          </Label>
          <Input
            id="representative-name"
            required
            placeholder="テキストを入力"
            className={FIELD_CLASS}
            value={representativeName}
            onChange={(e) => setRepresentativeName(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="phone-number">
            代表者電話番号 <RequiredBadge />
          </Label>
          <Input
            id="phone-number"
            type="tel"
            required
            placeholder="09012345678"
            className={FIELD_CLASS}
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="email">
            メールアドレス(ログインID) <RequiredBadge />
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
        <div className="mt-6">
          <Label htmlFor="password">
            パスワード <RequiredBadge />
          </Label>
          <Input
            id="password"
            type="password"
            required
            minLength={8}
            placeholder="8文字以上"
            className={FIELD_CLASS}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="mt-6">
          <Label htmlFor="password-confirm">
            パスワード確認 <RequiredBadge />
          </Label>
          <Input
            id="password-confirm"
            type="password"
            required
            minLength={8}
            placeholder="もう一度入力"
            className={FIELD_CLASS}
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
          />
        </div>
        <div className="mt-6 flex items-center gap-4">
          <Checkbox  className="data-[state=checked]:bg-brand-blue data-[state=checked]:border-brand-blue"/>
          <Label>
            <Link to="#" className="underline">利用規約</Link>
            ・
            <Link to="#" className="underline">プライバシーポリシー</Link>に同意
          </Label>
        </div>
        {error && <p className="mt-4 text-center text-xs text-destructive">{error}</p>}
        <div className="mt-8 flex items-center">
          <Button
            className="mx-auto rounded-full px-8 py-2 text-lg"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "登録中..." : "登録する"}
          </Button>
        </div>
        <div className="grid mt-6">
          <Link to={"/login"} className="underline text-brand-blue text-sm font-thin w-full text-center">{"<"} ログインに戻る</Link>
        </div>
      </form>
    </Wrapper>
  );
}
