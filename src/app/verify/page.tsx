import { VerificationForm } from '@/components/certificates/verification-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function VerifyPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6"
    >
      <p className="text-primary text-sm font-semibold">Certificate verification</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Check a certificate</h1>
      <p className="text-muted-foreground mt-3 max-w-xl">
        Enter the code printed on the certificate. We confirm whether that code is valid
        and which organisation issued it. When the seal includes a holder name, you can
        check the name printed on the document. We do not show personal application
        information.
      </p>
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-lg">Certificate code</CardTitle>
        </CardHeader>
        <CardContent>
          <VerificationForm />
        </CardContent>
      </Card>
    </main>
  );
}
