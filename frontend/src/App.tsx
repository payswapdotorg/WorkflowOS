import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import ProjectPage from './pages/ProjectPage';
import WorkItemPage from './pages/WorkItemPage';
import AuditPage from './pages/AuditPage';
import Layout from './components/Layout';

export default function App() {
  const { hasApiKey } = useAuth();

  if (!hasApiKey) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/work-items/:workItemId" element={<WorkItemPage />} />
        <Route path="/projects/:projectId/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </Layout>
  );
}
