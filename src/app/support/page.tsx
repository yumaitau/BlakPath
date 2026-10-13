import Link from 'next/link';
import { ContactValue } from '@/components/legal/legal-page';
import { Button } from '@/components/ui/button';
import { PLATFORM_CONTACT } from '@/lib/legal/documents';

export default function SupportPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6"
    >
      <h1 className="text-3xl font-semibold tracking-tight">Support</h1>
      <div className="text-muted-foreground mt-6 space-y-5 leading-7">
        <p>
          For a question about an application, evidence or a certificate, contact the
          organisation that is managing the matter. They are the people authorised to
          explain their process and make decisions.
        </p>
        <p>
          If you are a staff member, sign in to see your organisation’s work and
          notifications. Never send sensitive documents or personal details through an
          unverified channel.
        </p>
        <p>
          For a problem with BlakPath itself, such as a fault, a security concern or an
          accessibility barrier, contact the BlakPath platform team:{' '}
          <ContactValue value={PLATFORM_CONTACT.supportEmail} kind="email" />. Do not
          include personal details about an application in your message.
        </p>
        <p>
          Read the{' '}
          <Link href="/privacy" className="text-primary underline underline-offset-4">
            privacy policy
          </Link>
          ,{' '}
          <Link href="/terms" className="text-primary underline underline-offset-4">
            terms of use
          </Link>{' '}
          and{' '}
          <Link
            href="/accessibility"
            className="text-primary underline underline-offset-4"
          >
            accessibility statement
          </Link>
          .
        </p>
      </div>
      <Button asChild className="mt-7">
        <Link href="/sign-in">Staff sign in</Link>
      </Button>
    </main>
  );
}
