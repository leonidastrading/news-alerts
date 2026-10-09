import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "News Alerts",
  description: "Stocks that moved after a headline: every alert, its paper trade and how it turned out.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="wrap">{children}</main>
        <footer className="footer">
          <div className="wrap">
            News: Benzinga via Alpaca. Prices: IEX via Alpaca. Trades are placed on an Alpaca paper account; no real money.
            Not investment advice.
          </div>
        </footer>
      </body>
    </html>
  );
}
