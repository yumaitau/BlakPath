import Link from 'next/link';

/**
 * Public site footer (RSC).
 *
 * Provides a secondary navigation landmark for accessibility, privacy, terms
 * and support links, and a plain-English statement of the product's boundaries.
 */
function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-border bg-surface-muted mt-16 border-t">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-8 md:flex-row md:justify-between">
          <div className="max-w-md">
            <p className="text-foreground text-lg font-semibold">
              <span className="text-primary">Blak</span>Path
            </p>
            <p className="text-muted-foreground mt-2 text-sm">
              A secure case-management and evidence platform for authorised Aboriginal and
              Torres Strait Islander organisations administering Confirmation of
              Aboriginality applications. BlakPath supports the people doing this work; it
              never determines a person&rsquo;s Aboriginality.
            </p>
          </div>

          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-10 gap-y-3 text-sm sm:grid-cols-3"
          >
            <Link
              href="/accessibility"
              className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Accessibility
            </Link>
            <Link
              href="/privacy"
              className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Terms of use
            </Link>
            <Link
              href="/support"
              className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Support
            </Link>
            <Link
              href="/organisations"
              className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Find an organisation
            </Link>
            <Link
              href="/verify"
              className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Verify a certificate
            </Link>
            <Link
              href="/sign-in"
              className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Sign in
            </Link>
          </nav>
        </div>

        <p className="border-border text-muted-foreground mt-8 border-t pt-6 text-xs">
          &copy; {year} BlakPath. Data stored in Australia (ap-southeast-2). Made with
          respect for community control and self-determination.
        </p>
      </div>
    </footer>
  );
}

export { SiteFooter };
