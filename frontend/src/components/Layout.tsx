import { useAuth } from '../hooks/useAuth';
import { Link } from 'react-router-dom';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { clearApiKey } = useAuth();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '10px 20px', borderBottom: '1px solid #ddd', display: 'flex', justifyContent: 'space-between' }}>
        <Link to="/" style={{ textDecoration: 'none', color: '#333' }}>
          <strong>WorkflowOS</strong>
        </Link>
        <button onClick={clearApiKey} style={{ padding: '4px 12px' }}>Sign Out</button>
      </header>
      <main style={{ flex: 1, padding: 20 }}>
        {children}
      </main>
      <footer style={{ padding: '10px 20px', borderTop: '1px solid #ddd', marginTop: 'auto', fontSize: 12, color: '#999' }}>
        WorkflowOS — Backend retains all authoritative state.
      </footer>
    </div>
  );
}
