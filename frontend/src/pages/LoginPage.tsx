import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { setApiKey } = useAuth();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) {
      setError('API key is required');
      return;
    }
    setApiKey(key.trim());
  };

  return (
    <div data-testid="login-page" style={{ maxWidth: 400, margin: '100px auto', padding: 20 }}>
      <h1>WorkflowOS</h1>
      <p>Enter your API key to sign in.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="API Key"
          style={{ width: '100%', padding: 8, marginBottom: 10 }}
        />
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button type="submit" style={{ padding: '8px 16px' }}>Sign In</button>
      </form>
    </div>
  );
}
