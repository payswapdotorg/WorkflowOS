import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import ProjectListPage from './pages/ProjectListPage';
import ProjectPage from './pages/ProjectPage';
import WorkItemPage from './pages/WorkItemPage';
import AuditPage from './pages/AuditPage';
import Layout from './components/Layout';

/**
 * WORK-022 root application.
 *
 * The frontend is a consumer only — it never decides authorization. The
 * `useAuth` hook only tracks whether an API key has been entered locally;
 * the backend is the authority for every visible state value.
 */
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
        <Route path="/" element={<ProjectListPage />} />
        <Route path="/projects" element={<ProjectListPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/work-items/:workItemId" element={<WorkItemPage />} />
        <Route path="/projects/:projectId/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
