import { Employee, AppUsage, WebActivity, ActivityLog } from './supabaseClient';

export interface ReportData {
  employee?: Employee;
  period: string;
  startDate: string;
  endDate: string;
  appUsage: AppUsage[];
  webActivity: WebActivity[];
  activityLogs: ActivityLog[];
  analytics: any;
  projectFilter?: string | null;
}

export interface TemplateConfig {
  includeLogo?: boolean;
  logoUrl?: string;
  companyName?: string;
  reportTitle?: string;
  includeCharts?: boolean;
  includeExecutiveSummary?: boolean;
  includeDetailedBreakdown?: boolean;
  includeRecommendations?: boolean;
}

export class ProfessionalReportGenerator {
  private config: TemplateConfig;

  constructor(config: TemplateConfig = {}) {
    this.config = {
      includeLogo: false,
      includeCharts: true,
      includeExecutiveSummary: true,
      includeDetailedBreakdown: true,
      includeRecommendations: true,
      companyName: 'Mycroscope Corp',
      reportTitle: 'Productivity Analysis Report',
      ...config
    };
  }

  generateProfessionalReport(data: ReportData): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${this.config.reportTitle}</title>
          <style>
            body {
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
              line-height: 1.6;
              color: #1f2937;
              background-color: #ffffff;
              font-size: 12px;
              margin: 0;
              padding: 20px;
            }
            
            .header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 30px;
              padding-bottom: 20px;
              border-bottom: 2px solid #e5e7eb;
            }
            
            .logo-section {
              display: flex;
              align-items: center;
              gap: 15px;
            }
            
            .logo {
              width: 60px;
              height: 60px;
              background: linear-gradient(135deg, #1e3a8a, #3b82f6);
              border-radius: 12px;
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font-weight: bold;
              font-size: 24px;
            }
            
            .company-info h1 {
              font-size: 24px;
              font-weight: 700;
              color: #1e3a8a;
              margin-bottom: 5px;
            }
            
            .company-info p {
              font-size: 14px;
              color: #6b7280;
              font-weight: 500;
            }
            
            .report-meta {
              text-align: right;
            }
            
            .report-meta h2 {
              font-size: 20px;
              font-weight: 600;
              color: #1f2937;
              margin-bottom: 8px;
            }
            
            .report-meta p {
              font-size: 12px;
              color: #6b7280;
              margin-bottom: 4px;
            }
            
            .executive-summary {
              background: linear-gradient(135deg, #f8fafc, #f1f5f9);
              border-radius: 12px;
              padding: 25px;
              margin-bottom: 30px;
              border-left: 4px solid #1e3a8a;
            }
            
            .section-title {
              font-size: 18px;
              font-weight: 600;
              color: #1f2937;
              margin-bottom: 15px;
              display: flex;
              align-items: center;
              gap: 8px;
            }
            
            .section-title::before {
              content: '';
              width: 4px;
              height: 20px;
              background: #1e3a8a;
              border-radius: 2px;
            }
            
            .metrics-grid {
              display: grid;
              grid-template-columns: repeat(4, 1fr);
              gap: 15px;
              margin-bottom: 20px;
            }
            
            .metric-card {
              background: white;
              border-radius: 8px;
              padding: 15px;
              text-align: center;
              border: 1px solid #e5e7eb;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            
            .metric-value {
              font-size: 24px;
              font-weight: 700;
              color: #1e3a8a;
              margin-bottom: 5px;
            }
            
            .metric-label {
              font-size: 11px;
              color: #6b7280;
              font-weight: 500;
              text-transform: uppercase;
              letter-spacing: 0.5px;
            }
            
            .content-section {
              margin-bottom: 25px;
            }
            
            .data-table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 15px;
              background: white;
              border-radius: 8px;
              overflow: hidden;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            
            .data-table th {
              background: #f8fafc;
              padding: 12px;
              text-align: left;
              font-weight: 600;
              font-size: 11px;
              color: #374151;
              border-bottom: 1px solid #e5e7eb;
            }
            
            .data-table td {
              padding: 12px;
              border-bottom: 1px solid #f3f4f6;
              font-size: 11px;
            }
            
            .footer {
              margin-top: 40px;
              padding-top: 20px;
              border-top: 1px solid #e5e7eb;
              text-align: center;
              color: #6b7280;
              font-size: 10px;
            }
          </style>
        </head>
        <body>
          ${this.generateHeader(data)}
          ${this.generateExecutiveSummary(data)}
          ${this.generateDetailedAnalysis(data)}
          ${this.generateFooter()}
        </body>
      </html>
    `;
  }

  private generateHeader(data: ReportData): string {
    const employeeName = data.employee?.name || 'All Employees';
    const periodText = this.getPeriodText(data.period);
    const projectText = data.projectFilter ? ` - Project: ${data.projectFilter}` : '';
    
    return `
      <div class="header">
        <div class="logo-section">
          <div class="logo">M</div>
          <div class="company-info">
            <h1>${this.config.companyName}</h1>
            <p>Productivity Analytics Platform</p>
          </div>
        </div>
        <div class="report-meta">
          <h2>${this.config.reportTitle}</h2>
          <p><strong>Employee:</strong> ${employeeName}</p>
          <p><strong>Period:</strong> ${periodText}${projectText}</p>
          <p><strong>Generated:</strong> ${new Date().toLocaleDateString()}</p>
        </div>
      </div>
    `;
  }

  private generateExecutiveSummary(data: ReportData): string {
    const summary = this.calculateSummary(data);
    
    return `
      <div class="executive-summary">
        <div class="section-title">Executive Summary</div>
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-value">${summary.totalHours}h</div>
            <div class="metric-label">Total Hours</div>
          </div>
          <div class="metric-card">
            <div class="metric-value">${summary.activeHours}h</div>
            <div class="metric-label">Active Time</div>
          </div>
          <div class="metric-card">
            <div class="metric-value">${summary.productivityScore}%</div>
            <div class="metric-label">Productivity</div>
          </div>
          <div class="metric-card">
            <div class="metric-value">${summary.appsUsed}</div>
            <div class="metric-label">Apps Used</div>
          </div>
        </div>
      </div>
    `;
  }

  private generateDetailedAnalysis(data: ReportData): string {
    const appAnalysis = this.analyzeAppUsage(data.appUsage);
    const webAnalysis = this.analyzeWebActivity(data.webActivity);
    const productivityInsights = this.generateProductivityInsights(data);
    const recommendations = this.generateRecommendations(data);
    
    return `
      <div class="content-section">
        <div class="section-title">📊 Detailed Productivity Analysis</div>
        
        <div style="margin-bottom: 25px;">
          <h3 style="color: #1e3a8a; font-size: 16px; margin-bottom: 10px;">Application Usage Breakdown</h3>
          <p style="color: #6b7280; font-size: 12px; margin-bottom: 15px; line-height: 1.5;">
            This analysis provides insights into how time is distributed across different applications, 
            helping identify productivity patterns and potential optimization opportunities.
          </p>
          <table class="data-table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Time Spent</th>
                <th>Sessions</th>
                <th>Avg Session</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${appAnalysis.topApps.map(app => `
                <tr>
                  <td><strong>${app.name}</strong></td>
                  <td>${this.formatDuration(app.duration)}</td>
                  <td>${app.sessions}</td>
                  <td>${this.formatDuration(app.duration / app.sessions)}</td>
                  <td>${app.isActive ? '🟢 Active' : '⚪ Inactive'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div style="margin-bottom: 25px;">
          <h3 style="color: #1e3a8a; font-size: 16px; margin-bottom: 10px;">Web Activity Analysis</h3>
          <p style="color: #6b7280; font-size: 12px; margin-bottom: 15px; line-height: 1.5;">
            Understanding web browsing patterns helps identify research time, communication tools usage, 
            and potential distractions that may impact productivity.
          </p>
          <table class="data-table">
            <thead>
              <tr>
                <th>Website</th>
                <th>Time Spent</th>
                <th>Visits</th>
                <th>Most Visited Page</th>
              </tr>
            </thead>
            <tbody>
              ${webAnalysis.topSites.map(site => `
                <tr>
                  <td><strong>${site.domain}</strong></td>
                  <td>${this.formatDuration(site.duration)}</td>
                  <td>${site.visits}</td>
                  <td>${site.mostVisitedPage}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div style="margin-bottom: 25px;">
          <h3 style="color: #1e3a8a; font-size: 16px; margin-bottom: 10px;">🔍 Productivity Insights</h3>
          <div style="background: #f8fafc; border-radius: 8px; padding: 15px; border-left: 4px solid #1e3a8a;">
            ${productivityInsights.map(insight => `
              <div style="margin-bottom: 10px;">
                <strong style="color: #1e3a8a;">• ${insight.title}:</strong>
                <span style="color: #374151; font-size: 12px;"> ${insight.description}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div style="margin-bottom: 25px;">
          <h3 style="color: #1e3a8a; font-size: 16px; margin-bottom: 10px;">💡 Strategic Recommendations</h3>
          <div style="background: #f0f9ff; border-radius: 8px; padding: 15px; border-left: 4px solid #0ea5e9;">
            ${recommendations.map(rec => `
              <div style="margin-bottom: 12px;">
                <strong style="color: #0ea5e9;">🎯 ${rec.title}</strong>
                <p style="color: #374151; font-size: 12px; margin: 5px 0; line-height: 1.4;">${rec.description}</p>
                ${rec.impact ? `<em style="color: #6b7280; font-size: 11px;">Expected Impact: ${rec.impact}</em>` : ''}
              </div>
            `).join('')}
          </div>
        </div>

        <div style="margin-bottom: 25px;">
          <h3 style="color: #1e3a8a; font-size: 16px; margin-bottom: 10px;">📈 Performance Metrics</h3>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px;">
            <div style="background: white; border-radius: 8px; padding: 15px; border: 1px solid #e5e7eb;">
              <div style="font-size: 20px; font-weight: bold; color: #059669;">${appAnalysis.focusScore}%</div>
              <div style="font-size: 11px; color: #6b7280;">Focus Score</div>
              <div style="font-size: 10px; color: #6b7280; margin-top: 5px;">Time spent on primary tasks</div>
            </div>
            <div style="background: white; border-radius: 8px; padding: 15px; border: 1px solid #e5e7eb;">
              <div style="font-size: 20px; font-weight: bold; color: #dc2626;">${appAnalysis.distractionScore}%</div>
              <div style="font-size: 11px; color: #6b7280;">Distraction Score</div>
              <div style="font-size: 10px; color: #6b7280; margin-top: 5px;">Time on non-work activities</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private generateFooter(): string {
    return `
      <div class="footer">
        <p>Generated by Mycroscope Productivity Tracking System</p>
        <p>© 2024 ${this.config.companyName} - Confidential Report</p>
      </div>
    `;
  }

  private calculateSummary(data: ReportData) {
    const totalSeconds = data.appUsage.reduce((sum, app) => sum + (app.duration_seconds || 0), 0);
    const totalHours = Math.round((totalSeconds / 3600) * 10) / 10;
    
    const activeSeconds = data.appUsage.reduce((sum, app) => {
      const duration = app.duration_seconds || 0;
      return sum + (duration * 0.8);
    }, 0);
    const activeHours = Math.round((activeSeconds / 3600) * 10) / 10;
    
    const productivityScore = Math.round((activeHours / totalHours) * 100) || 0;
    const appsUsed = new Set(data.appUsage.map(app => app.app_name)).size;
    
    return {
      totalHours,
      activeHours,
      productivityScore,
      appsUsed
    };
  }

  private analyzeAppUsage(appUsage: AppUsage[]) {
    const appMap = new Map<string, any>();
    
    appUsage.forEach(app => {
      if (!appMap.has(app.app_name)) {
        appMap.set(app.app_name, {
          name: app.app_name,
          duration: 0,
          sessions: 0,
          isActive: false
        });
      }
      
      const appData = appMap.get(app.app_name);
      appData.duration += app.duration_seconds || 0;
      appData.sessions += 1;
      if (!app.end_time) appData.isActive = true;
    });
    
    const apps = Array.from(appMap.values());
    const totalDuration = apps.reduce((sum, app) => sum + app.duration, 0);
    
    // Calculate focus and distraction scores
    const productiveApps = ['code', 'visual studio', 'intellij', 'eclipse', 'atom', 'sublime', 'figma', 'sketch', 'adobe', 'office', 'excel', 'word', 'powerpoint'];
    const productiveTime = apps
      .filter(app => productiveApps.some(prod => app.name.toLowerCase().includes(prod)))
      .reduce((sum, app) => sum + app.duration, 0);
    
    const focusScore = totalDuration > 0 ? Math.round((productiveTime / totalDuration) * 100) : 0;
    const distractionScore = 100 - focusScore;
    
    return {
      topApps: apps.sort((a, b) => b.duration - a.duration).slice(0, 10),
      focusScore,
      distractionScore
    };
  }

  private analyzeWebActivity(webActivity: WebActivity[]) {
    const siteMap = new Map<string, any>();
    
    webActivity.forEach(site => {
      const domain = site.domain || 'Unknown';
      if (!siteMap.has(domain)) {
        siteMap.set(domain, {
          domain: domain,
          duration: 0,
          visits: 0,
          pages: new Map<string, number>()
        });
      }
      
      const siteData = siteMap.get(domain);
      siteData.duration += site.duration_seconds || 0;
      siteData.visits += 1;
      
      if (site.title) {
        siteData.pages.set(site.title, (siteData.pages.get(site.title) || 0) + 1);
      }
    });
    
    const sites = Array.from(siteMap.values()).map(site => ({
        ...site,
        mostVisitedPage: Array.from(site.pages.entries())
          .sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A'
      }));
      
      return {
        topSites: sites.sort((a, b) => b.duration - a.duration).slice(0, 10)
      };
    }

  private generateProductivityInsights(data: ReportData) {
    const insights = [];
    const appAnalysis = this.analyzeAppUsage(data.appUsage);
    const webAnalysis = this.analyzeWebActivity(data.webActivity);
    
    // App usage insights
    if (appAnalysis.topApps.length > 0) {
      const topApp = appAnalysis.topApps[0];
      insights.push({
        title: 'Primary Application',
        description: `${topApp.name} is the most used application with ${this.formatDuration(topApp.duration)} of total time, indicating it's the core tool for daily tasks.`
      });
    }
    
    // Focus score insights
    if (appAnalysis.focusScore > 70) {
      insights.push({
        title: 'Excellent Focus',
        description: `High focus score of ${appAnalysis.focusScore}% shows strong concentration on productive applications.`
      });
    } else if (appAnalysis.focusScore < 50) {
      insights.push({
        title: 'Focus Improvement Needed',
        description: `Low focus score of ${appAnalysis.focusScore}% suggests potential distractions or inefficient tool usage.`
      });
    }
    
    // Web activity insights
    if (webAnalysis.topSites.length > 0) {
      const topSite = webAnalysis.topSites[0];
      insights.push({
        title: 'Most Visited Website',
        description: `${topSite.domain} received the most attention with ${this.formatDuration(topSite.duration)} and ${topSite.visits} visits.`
      });
    }
    
    // Session analysis
    const avgSessions = appAnalysis.topApps.reduce((sum, app) => sum + app.sessions, 0) / appAnalysis.topApps.length;
    if (avgSessions > 10) {
      insights.push({
        title: 'Frequent Context Switching',
        description: `Average of ${Math.round(avgSessions)} sessions per app suggests frequent task switching, which may impact productivity.`
      });
    }
    
    return insights;
  }

  private generateRecommendations(data: ReportData) {
    const recommendations = [];
    const appAnalysis = this.analyzeAppUsage(data.appUsage);
    const webAnalysis = this.analyzeWebActivity(data.webActivity);
    
    // Focus improvement recommendations
    if (appAnalysis.focusScore < 70) {
      recommendations.push({
        title: 'Optimize Application Usage',
        description: 'Consider consolidating work into fewer applications to reduce context switching and improve focus.',
        impact: 'Potential 15-20% productivity increase'
      });
    }
    
    // Session management recommendations
    const avgSessions = appAnalysis.topApps.reduce((sum, app) => sum + app.sessions, 0) / appAnalysis.topApps.length;
    if (avgSessions > 8) {
      recommendations.push({
        title: 'Implement Time Blocking',
        description: 'Schedule dedicated time blocks for specific tasks to reduce frequent app switching and improve concentration.',
        impact: 'Reduced context switching by 30-40%'
      });
    }
    
    // Web usage recommendations
    if (webAnalysis.topSites.length > 0) {
      const socialSites = webAnalysis.topSites.filter(site => 
        ['facebook', 'twitter', 'instagram', 'youtube', 'tiktok'].some(social => 
          site.domain.toLowerCase().includes(social)
        )
      );
      
      if (socialSites.length > 0) {
        recommendations.push({
          title: 'Manage Social Media Usage',
          description: 'Consider setting time limits for social media sites during work hours to minimize distractions.',
          impact: 'Improved focus and reduced time waste'
        });
      }
    }
    
    // General productivity recommendations
    recommendations.push({
      title: 'Regular Productivity Reviews',
      description: 'Schedule weekly reviews of productivity patterns to identify trends and make continuous improvements.',
      impact: 'Ongoing productivity optimization'
    });
    
    return recommendations;
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private getPeriodText(period: string): string {
    switch (period) {
      case 'today': return 'Today';
      case 'week': return 'Last 7 Days';
      case 'month': return 'Last Month';
      case 'quarter': return 'Last Quarter';
      default: return period;
    }
  }
}

export const defaultReportGenerator = new ProfessionalReportGenerator(); 