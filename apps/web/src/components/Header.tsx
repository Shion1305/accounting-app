import { useState } from "react";
import { Link } from "react-router-dom";
import waveTop from "@/components/images/Wave_Top.avif";
import { HouseIcon, ListIcon } from "@phosphor-icons/react";

export type HeaderMenuItem = {
  label: string;
  to?: string;
  onClick?: () => void;
};

type HeaderProps = {
  menuItems?: HeaderMenuItem[];
};

const Header = ({ menuItems }: HeaderProps) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className="relative">
      <div className="absolute left-0 top-0 z-20 m-4">
        <button
          type="button"
          aria-label="メニュー"
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          <ListIcon size={32} className="size-8 text-white"/>
        </button>
        <button className="absolute ml-2">
          <Link to={"/dashboard"}>
            <HouseIcon size={32} className="size-8 text-white"/>
          </Link>
        </button>
      </div>
      {isMenuOpen && (
        <>
          <button
            type="button"
            aria-label="メニューを閉じる"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setIsMenuOpen(false)}
          />
          <nav className="absolute left-4 top-16 z-30 w-48 overflow-hidden rounded-xl border-2 border-brand-blue bg-card shadow-lg">
            {menuItems && menuItems.length > 0 ? (
              menuItems.map((item) =>
                item.to ? (
                  <Link
                    key={item.label}
                    to={item.to}
                    onClick={() => setIsMenuOpen(false)}
                    className="block px-4 py-3 text-sm hover:bg-muted"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      item.onClick?.();
                      setIsMenuOpen(false);
                    }}
                    className="block w-full px-4 py-3 text-left text-sm hover:bg-muted"
                  >
                    {item.label}
                  </button>
                ),
              )
            ) : (
              <Link
                to="/"
                onClick={() => setIsMenuOpen(false)}
                className="block px-4 py-3 text-sm hover:bg-muted"
              >
                トップページ
              </Link>
            )}
          </nav>
        </>
      )}
      <img src={waveTop} className="max-h-40 w-full" alt="" />
    </header>
  );
};

export default Header;
