import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function LoginPage() {
  const { setApiKey } = useAuth();
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) {
      setError('API key is required');
      return;
    }
    setLoading(true);
    setError(null);
    // Set the API key — the backend is the authority. If the key is wrong,
    // the first API call will return 401 and the UI will show an error.
    setApiKey(key.trim());
    setLoading(false);
    navigate('/');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="flex items-center justify-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <span className="font-bold">W</span>
            </div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">WorkflowOS</h1>
          <p className="text-sm text-muted-foreground">
            Build reliable software from architecture to verified implementation.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api-key">API Key</Label>
            <Input
              id="api-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Enter your API key"
              disabled={loading}
              autoFocus
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Continue'}
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          The backend retains all authoritative state.
        </p>
      </div>
    </div>
  );
}
