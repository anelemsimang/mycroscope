'use client'

import { useState } from 'react'
import { Download, Calendar, Filter, TrendingUp, Users, Clock, Activity, BarChart3 } from 'lucide-react'

interface Report {
  id: string
  type: string
  title: string
  description: string
  dateRange: string
  status: 'generated' | 'generating' | 'failed'
  downloadUrl?: string
  createdAt: string
}

interface ReportsProps {
  reports: Report[]
  onGenerateReport: (type: string, dateRange: { from: string; to: string }) => Promise<void>
  onDownloadReport: (reportId: string) => Promise<void>
}

export default function Reports({ reports, onGenerateReport, onDownloadReport }: ReportsProps) {
  const [selectedReportType, setSelectedReportType] = useState('productivity')
  const [dateRange, setDateRange] = useState({ from: '', to: '' })
  const [generating, setGenerating] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)

  const reportTypes = [
    {
      id: 'productivity',
      name: 'Productivity Report',
      description: 'Overall productivity metrics and trends',
      icon: TrendingUp,
      color: 'bg-blue-100 text-blue-800'
    },
    {
      id: 'employee',
      name: 'Employee Performance',
      description: 'Individual employee performance analysis',
      icon: Users,
      color: 'bg-green-100 text-green-800'
    },
    {
      id: 'time',
      name: 'Time Tracking',
      description: 'Detailed time tracking and attendance',
      icon: Clock,
      color: 'bg-purple-100 text-purple-800'
    },
    {
      id: 'activity',
      name: 'Activity Logs',
      description: 'Comprehensive activity and behavior logs',
      icon: Activity,
      color: 'bg-orange-100 text-orange-800'
    },
    {
      id: 'analytics',
      name: 'Analytics Summary',
      description: 'Key metrics and insights summary',
      icon: BarChart3,
      color: 'bg-indigo-100 text-indigo-800'
    }
  ]

  const handleGenerateReport = async () => {
    if (!dateRange.from || !dateRange.to) {
      alert('Please select both start and end dates')
      return
    }
    
    setGenerating(true)
    try {
      await onGenerateReport(selectedReportType, dateRange)
    } catch (error) {
      console.error('Failed to generate report:', error)
    } finally {
      setGenerating(false)
    }
  }

  const handleDownloadReport = async (reportId: string) => {
    setDownloading(reportId)
    try {
      await onDownloadReport(reportId)
    } catch (error) {
      console.error('Failed to download report:', error)
    } finally {
      setDownloading(null)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'generated': return 'bg-green-100 text-green-800'
      case 'generating': return 'bg-yellow-100 text-yellow-800'
      case 'failed': return 'bg-red-100 text-red-800'
      default: return 'bg-gray-100 text-gray-800'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'generated': return '✅'
      case 'generating': return '⏳'
      case 'failed': return '❌'
      default: return '❓'
    }
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-medium text-gray-900">Reports</h2>
        <button 
          onClick={handleGenerateReport}
          disabled={generating || !dateRange.from || !dateRange.to}
          className="flex items-center px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
        >
          <Download className="h-4 w-4 mr-2" />
          {generating ? 'Generating...' : 'Generate Report'}
        </button>
      </div>

      {/* Report Generation Section */}
      <div className="bg-white shadow rounded-lg p-6 mb-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Generate New Report</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Report Type Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Report Type</label>
            <div className="space-y-2">
              {reportTypes.map((type) => {
                const Icon = type.icon
                return (
                  <div
                    key={type.id}
                    onClick={() => setSelectedReportType(type.id)}
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      selectedReportType === type.id
                        ? 'border-indigo-500 bg-indigo-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center">
                      <Icon className="h-5 w-5 mr-3 text-gray-600" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">{type.name}</div>
                        <div className="text-xs text-gray-500">{type.description}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Date Range Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Date Range</label>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">From Date</label>
                <div className="relative">
                  <Calendar className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                  <input
                    type="date"
                    value={dateRange.from}
                    onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })}
                    className="pl-8 pr-3 py-2 border border-gray-300 rounded-md w-full focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">To Date</label>
                <div className="relative">
                  <Calendar className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                  <input
                    type="date"
                    value={dateRange.to}
                    onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })}
                    className="pl-8 pr-3 py-2 border border-gray-300 rounded-md w-full focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Quick Date Presets */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Quick Presets</label>
            <div className="space-y-2">
              {[
                { label: 'Last 7 Days', days: 7 },
                { label: 'Last 30 Days', days: 30 },
                { label: 'Last 90 Days', days: 90 },
                { label: 'This Month', custom: () => {
                  const now = new Date()
                  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1)
                  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0)
                  return {
                    from: firstDay.toISOString().split('T')[0],
                    to: lastDay.toISOString().split('T')[0]
                  }
                }},
                { label: 'Last Month', custom: () => {
                  const now = new Date()
                  const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1)
                  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0)
                  return {
                    from: firstDay.toISOString().split('T')[0],
                    to: lastDay.toISOString().split('T')[0]
                  }
                }}
              ].map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => {
                    if (preset.custom) {
                      setDateRange(preset.custom())
                    } else if (preset.days) {
                      const to = new Date()
                      const from = new Date()
                      from.setDate(from.getDate() - preset.days)
                      setDateRange({
                        from: from.toISOString().split('T')[0],
                        to: to.toISOString().split('T')[0]
                      })
                    }
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Generated Reports List */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">Generated Reports</h3>
          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4 text-gray-400" />
            <span className="text-sm text-gray-500">{reports.length} reports</span>
          </div>
        </div>

        {reports.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 text-6xl mb-4">📊</div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No reports generated yet</h3>
            <p className="text-gray-500">Generate your first report using the form above.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {reports.map((report) => {
              const reportType = reportTypes.find(type => type.id === report.type)
              const Icon = reportType?.icon || BarChart3
              
              return (
                <div key={report.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <div className={`p-2 rounded-lg ${reportType?.color || 'bg-gray-100'}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <h4 className="text-lg font-medium text-gray-900">{report.title}</h4>
                        <p className="text-sm text-gray-500">{report.description}</p>
                        <div className="flex items-center space-x-4 mt-1">
                          <span className="text-xs text-gray-400">
                            {report.dateRange}
                          </span>
                          <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(report.status)}`}>
                            {getStatusIcon(report.status)} {report.status}
                          </span>
                          <span className="text-xs text-gray-400">
                            Generated: {new Date(report.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center space-x-2">
                      {report.status === 'generated' && (
                        <button
                          onClick={() => handleDownloadReport(report.id)}
                          disabled={downloading === report.id}
                          className="flex items-center px-3 py-1 text-sm text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                        >
                          <Download className="h-4 w-4 mr-1" />
                          {downloading === report.id ? 'Downloading...' : 'Download'}
                        </button>
                      )}
                      {report.status === 'generating' && (
                        <div className="flex items-center text-sm text-yellow-600">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-600 mr-2"></div>
                          Generating...
                        </div>
                      )}
                      {report.status === 'failed' && (
                        <button
                          onClick={() => handleGenerateReport()}
                          className="flex items-center px-3 py-1 text-sm text-red-600 hover:text-red-800"
                        >
                          <Download className="h-4 w-4 mr-1" />
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Report Templates */}
      <div className="mt-6 bg-white shadow rounded-lg p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Report Templates</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              name: 'Weekly Team Report',
              description: 'Weekly summary for team managers',
              schedule: 'Every Monday',
              type: 'productivity'
            },
            {
              name: 'Monthly Executive Summary',
              description: 'High-level metrics for executives',
              schedule: 'First day of month',
              type: 'analytics'
            },
            {
              name: 'Daily Activity Log',
              description: 'Daily activity tracking report',
              schedule: 'Every day at 6 PM',
              type: 'activity'
            },
            {
              name: 'Employee Performance Review',
              description: 'Individual performance analysis',
              schedule: 'Monthly',
              type: 'employee'
            },
            {
              name: 'Time & Attendance Report',
              description: 'Detailed time tracking report',
              schedule: 'Weekly',
              type: 'time'
            },
            {
              name: 'Productivity Trends',
              description: 'Long-term productivity analysis',
              schedule: 'Quarterly',
              type: 'productivity'
            }
          ].map((template, index) => (
            <div key={index} className="border border-gray-200 rounded-lg p-4 hover:border-gray-300 cursor-pointer">
              <h4 className="font-medium text-gray-900 mb-1">{template.name}</h4>
              <p className="text-sm text-gray-500 mb-2">{template.description}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">{template.schedule}</span>
                <button className="text-xs text-indigo-600 hover:text-indigo-800">
                  Use Template
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
} 