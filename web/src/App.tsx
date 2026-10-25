import { Link, Route, Routes } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { Layout } from './components/Layout';
import { LibraryPage } from './pages/LibraryPage';
import { ImportScorecardPage } from './pages/ImportScorecardPage';
import { ModelsPage } from './pages/ModelsPage';
import { NewEvaluationPage } from './pages/NewEvaluationPage';
import { ProjectPage } from './pages/ProjectPage';
import { BoardPage } from './pages/BoardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunPage } from './pages/RunPage';

function NotFound() {
  return (
    <div className="empty">
      <h3>That page does not exist</h3>
      <Link to="/projects" className="btn btn-secondary">Back to projects</Link>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route element={<Layout />}>
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="board" element={<BoardPage />} />
        <Route path="new" element={<NewEvaluationPage />} />
        <Route path="import-scorecard" element={<ImportScorecardPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="library/:id" element={<LibraryPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="projects/:id" element={<ProjectPage />} />
        <Route path="runs/:id" element={<RunPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
