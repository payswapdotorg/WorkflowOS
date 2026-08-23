import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { auth } from '@/api/client';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div><h1 className="text-xl font-semibold">Settings</h1><p className="text-sm text-muted-foreground">Manage your session and configuration</p></div>
      <Card>
        <CardHeader><CardTitle className="text-base">Session</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">You are authenticated with an API key. The backend retains all authoritative state.</p>
          <Button variant="destructive" onClick={() => auth.clearApiKey()}>Sign Out</Button>
        </CardContent>
      </Card>
    </div>
  );
}
