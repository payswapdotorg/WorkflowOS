import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import AppShell from './components/shell/AppShell';
import LoginPage from './pages/LoginPage';
import ProjectListPage from './pages/ProjectListPage';
import ProjectOverviewPage from './pages/ProjectOverviewPage';
import ArchitecturePage from './pages/ArchitecturePage';
import ArchitectPage from './pages/ArchitectPage';
import RequirementsPage from './pages/RequirementsPage';
import WorkItemsPage from './pages/WorkItemsPage';
import WorkItemPage from './pages/WorkItemPage';
import ActivityPage from './pages/ActivityPage';
import SettingsPage from './pages/SettingsPage';
import IntegrationsPage from './pages/IntegrationsPage';
import ProviderSettingsPage from './pages/ProviderSettingsPage';

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
    <Routes>
      <Route path="/" element={<ProjectListPage />} />
      <Route path="/projects" element={<ProjectListPage />} />
      <Route
        path="/projects/:projectId"
        element={
          <AppShell>
            <ProjectOverviewPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/architect"
        element={
          <AppShell>
            <ArchitectPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/architecture"
        element={
          <AppShell>
            <ArchitecturePage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/requirements"
        element={
          <AppShell>
            <RequirementsPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/work-items"
        element={
          <AppShell>
            <WorkItemsPage />
          </AppShell>
        }
      />
      <Route
        path="/work-items/:workItemId"
        element={
          <AppShell>
            <WorkItemPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/activity"
        element={
          <AppShell>
            <ActivityPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/settings"
        element={
          <AppShell>
            <SettingsPage />
          </AppShell>
        }
      />
      <Route
        path="/projects/:projectId/integrations"
        element={
          <AppShell>
            <IntegrationsPage />
          </AppShell>
        }
      />
      <Route
        path="/settings/providers"
        element={
          <AppShell>
            <ProviderSettingsPage />
          </AppShell>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
