import type { Metadata } from 'next'
import Script from 'next/script'
import { JetBrains_Mono, Syne } from 'next/font/google'
import './globals.css'
import { Sidebar } from '@/components/Sidebar'
import { Providers } from '@/components/Providers'

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
})

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Captains Prediction Companion',
  description: 'Deterministic market cards for Kalshi and companion workflows',
}

const cloudflareToken = process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${jetbrains.variable} ${syne.variable}`}>
      <body className="font-mono bg-void text-text-primary antialiased">
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex min-h-screen flex-1 flex-col p-4 pl-[13rem] md:p-6 md:pl-[13rem]">
              {children}
            </main>
          </div>
          {cloudflareToken ? (
            <Script
              id="cloudflare-web-analytics"
              src="https://static.cloudflareinsights.com/beacon.min.js"
              strategy="afterInteractive"
              data-cf-beacon={JSON.stringify({ token: cloudflareToken })}
            />
          ) : null}
        </Providers>
      </body>
    </html>
  )
}
