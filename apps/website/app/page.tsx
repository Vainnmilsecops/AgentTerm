import { DownloadSection } from './download-section';
import { FeaturesSection } from './features-section';
import { Hero } from './hero';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { VideoSection } from './video-section';
import { WorkflowSection } from './workflow-section';

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <WorkflowSection />
        <FeaturesSection />
        <VideoSection />
        <DownloadSection />
      </main>
      <SiteFooter />
    </>
  );
}
