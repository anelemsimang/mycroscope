import json
import psutil
import time
import threading
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Set
from pynput import mouse, keyboard
import pyautogui
import win32gui
import win32process
import win32api
import win32con

from config import (
    IDLE_THRESHOLD, ACTIVITY_CHECK_INTERVAL, TRACK_MOUSE_MOVEMENTS,
    TRACK_KEYBOARD_ACTIVITY, TRACK_APPLICATIONS, TRACK_WEB_ACTIVITY,
    TRACK_SCROLLING, BLACKLISTED_APPS, BLACKLISTED_URLS
)
from utils.logger import activity_logger
from .project_manager import ProjectManager


class ActivityTracker:
    """Real-time activity tracking system."""
    
    def __init__(self, employee_id: str, supabase_manager=None):
        self.employee_id = employee_id  # This is the string ID like "EMP001"
        self.employee_uuid = None  # This will store the actual UUID
        self.supabase_manager = supabase_manager
        self.is_tracking = False
        self.last_activity = datetime.now()
        self.idle_start = None
        self.current_app = None
        self.current_project = None  # Changed from "Default" to None to trigger project selection
        self.project_manager = None
        
        # Get the employee UUID from the supabase manager
        if self.supabase_manager and self.supabase_manager.current_employee:
            self.employee_uuid = self.supabase_manager.current_employee['id']
            organization_id = self.supabase_manager.current_employee['organization_id']
            # Initialize project manager
            self.project_manager = ProjectManager(self.supabase_manager.client, organization_id, self.employee_uuid)
            activity_logger.info(f"Activity tracker initialized with employee UUID: {self.employee_uuid}", employee_id=self.employee_uuid)
        else:
            activity_logger.warning("No employee UUID available for activity tracker", employee_id=self.employee_id)
        
        # Activity data - track active app sessions
        self.active_app_sessions = {}  # app_name -> session_start_time
        self.app_usage = {}
        self.web_activity = {}
        self.mouse_activity = {
            "clicks": 0,
            "scrolls": 0,
            "movements": 0
        }
        self.keyboard_activity = {
            "keystrokes": 0,
            "typing_time": 0
        }
        self.project_switches = []
        
        # Sync tracking
        self.last_sync_time = datetime.now()
        self.sync_interval = 5  # Keep 5 seconds for real-time data
        
        # Threading
        self.tracking_thread = None
        self.stop_event = threading.Event()
        
        # Listeners
        self.mouse_listener = None
        self.keyboard_listener = None
        
        # Initialize tracking
        self._setup_listeners()
    
    def _setup_listeners(self):
        """Setup mouse and keyboard listeners."""
        if TRACK_MOUSE_MOVEMENTS:
            self.mouse_listener = mouse.Listener(
                on_move=self._on_mouse_move,
                on_click=self._on_mouse_click,
                on_scroll=self._on_mouse_scroll
            )
        
        if TRACK_KEYBOARD_ACTIVITY:
            self.keyboard_listener = keyboard.Listener(
                on_press=self._on_key_press,
                on_release=self._on_key_release
            )
    
    def start_tracking(self):
        """Start activity tracking."""
        if self.is_tracking:
            return
        
        self.is_tracking = True
        self.stop_event.clear()
        
        # Start listeners
        if self.mouse_listener:
            self.mouse_listener.start()
        if self.keyboard_listener:
            self.keyboard_listener.start()
        
        # Start tracking thread
        self.tracking_thread = threading.Thread(target=self._tracking_loop, daemon=True)
        self.tracking_thread.start()
        
        # Use employee_uuid for logging if available, otherwise fall back to employee_id
        log_id = self.employee_uuid if self.employee_uuid else self.employee_id
        activity_logger.info("Activity tracking started", employee_id=log_id)
    
    def stop_tracking(self):
        """Stop activity tracking."""
        if not self.is_tracking:
            return
        
        self.is_tracking = False
        self.stop_event.set()
        
        # End any remaining active app sessions
        current_time = datetime.now()
        self._check_closed_apps(current_time)
        
        # Stop listeners
        if self.mouse_listener:
            self.mouse_listener.stop()
        if self.keyboard_listener:
            self.keyboard_listener.stop()
        
        # Wait for tracking thread
        if self.tracking_thread and self.tracking_thread.is_alive():
            self.tracking_thread.join(timeout=5)
        
        # Use employee_uuid for logging if available, otherwise fall back to employee_id
        log_id = self.employee_uuid if self.employee_uuid else self.employee_id
        activity_logger.info("Activity tracking stopped", employee_id=log_id)
    
    def _tracking_loop(self):
        """Main tracking loop."""
        while not self.stop_event.is_set():
            try:
                current_time = datetime.now()
                
                # Check for idle time
                self._check_idle_time(current_time)
                
                # Check for closed apps and end their sessions
                self._check_closed_apps(current_time)
                
                # Track current application
                if TRACK_APPLICATIONS:
                    self._track_current_app(current_time)
                
                # Track web activity
                if TRACK_WEB_ACTIVITY:
                    self._track_web_activity(current_time)
                
                # Sync data to Supabase periodically
                if self.supabase_manager and (current_time - self.last_sync_time).total_seconds() >= self.sync_interval:
                    self._sync_data_to_supabase(current_time)
                    self.last_sync_time = current_time
                
                # Sleep for interval
                time.sleep(ACTIVITY_CHECK_INTERVAL)
                
            except Exception as e:
                # Use employee_uuid for logging if available, otherwise fall back to employee_id
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.error("Error in tracking loop", error=str(e), employee_id=log_id)
                time.sleep(ACTIVITY_CHECK_INTERVAL)
    
    def _check_idle_time(self, current_time: datetime):
        """Check if user is idle."""
        time_diff = (current_time - self.last_activity).total_seconds()
        
        if time_diff > IDLE_THRESHOLD:
            if self.idle_start is None:
                self.idle_start = current_time
                # Use employee_uuid for logging if available, otherwise fall back to employee_id
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.log_idle(log_id, int(time_diff), current_time)
        else:
            if self.idle_start is not None:
                idle_duration = (current_time - self.idle_start).total_seconds()
                # Use employee_uuid for logging if available, otherwise fall back to employee_id
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.info("Idle period ended", 
                                   employee_id=log_id,
                                   idle_duration=int(idle_duration))
                self.idle_start = None
    
    def _track_current_app(self, current_time: datetime):
        """Track current active application."""
        try:
            # Get foreground window
            hwnd = win32gui.GetForegroundWindow()
            window_title = win32gui.GetWindowText(hwnd)
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            
            if pid:
                process = psutil.Process(pid)
                process_name = process.name()
                
                # Get a better app name using window title and process name
                app_name = self._get_friendly_app_name(window_title, process_name)
                
                # Debug logging
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.info(f"Debug: Current foreground app detected: {app_name}", employee_id=log_id)
                
                # Skip blacklisted apps
                if app_name in BLACKLISTED_APPS:
                    activity_logger.info(f"Debug: App {app_name} is blacklisted, skipping", employee_id=log_id)
                    return
                
                # Smart noise control for File Explorer
                if app_name == "explorer.exe":
                    # Only track if there's been recent user activity (not just background)
                    time_since_last_activity = (current_time - self.last_activity).total_seconds()
                    if time_since_last_activity > 30:  # Increased from 10 to 30 seconds
                        activity_logger.info(f"Debug: Skipping explorer.exe due to inactivity ({time_since_last_activity}s)", employee_id=log_id)
                        return
                    else:
                        activity_logger.info(f"Debug: Tracking explorer.exe with recent activity ({time_since_last_activity}s)", employee_id=log_id)
                
                # Check if this is a new app (not currently being tracked)
                if app_name not in self.active_app_sessions:
                    # New app session started
                    self.active_app_sessions[app_name] = current_time
                    
                    # Log the start of a new app session
                    activity_logger.info(f"App session started: {app_name}", 
                                       employee_id=log_id,
                                       app_name=app_name,
                                       session_start=current_time.isoformat())
                
                # Update current app
                if app_name != self.current_app:
                    old_app = self.current_app
                    self.current_app = app_name
                    activity_logger.info("App switched", 
                                       employee_id=log_id,
                                       app_name=app_name,
                                       old_app=old_app)
                    
                    # Create a final record for the app being switched away from
                    if old_app and old_app not in BLACKLISTED_APPS and self.supabase_manager and self.employee_uuid:
                        organization_id = None
                        if self.supabase_manager.current_employee:
                            organization_id = self.supabase_manager.current_employee['organization_id']
                        
                        if organization_id and old_app in self.active_app_sessions:
                            # Calculate duration for the old app
                            session_start = self.active_app_sessions[old_app]
                            session_duration = int((current_time - session_start).total_seconds())
                            
                            # Create final record for the old app
                            old_app_data = {
                                "employee_id": self.employee_uuid,
                                "organization_id": organization_id,
                                "app_name": old_app,
                                "window_title": old_app,
                                "duration_seconds": session_duration,
                                "start_time": session_start.isoformat(),
                                "end_time": current_time.isoformat(),  # App is no longer active
                                "is_active": False
                            }
                            
                            success = self.supabase_manager.sync_app_usage(old_app_data)
                            activity_logger.info(f"Final record created for switched app {old_app}: {'successful' if success else 'failed'}", employee_id=log_id)
                    
                    # Immediately update current activity record when app switches
                    activity_logger.info(f"🔄 Updating current activity record for new app: {app_name}", employee_id=log_id)
                    self._update_current_activity_record(current_time)
                else:
                    # Log when same app is detected (for debugging)
                    activity_logger.info(f"🔄 Same app detected: {app_name} (no switch needed)", employee_id=log_id)
                
                # Update app usage time
                if app_name not in self.app_usage:
                    self.app_usage[app_name] = 0
                self.app_usage[app_name] += ACTIVITY_CHECK_INTERVAL
                
                # Debug log app usage updates
                activity_logger.info(f"Debug: Updated app usage for {app_name}: {self.app_usage[app_name]}s", employee_id=log_id)
                
        except Exception as e:
            # Use employee_uuid for logging if available, otherwise fall back to employee_id
            log_id = self.employee_uuid if self.employee_uuid else self.employee_id
            activity_logger.error("Error tracking app", error=str(e), employee_id=log_id)
    
    def _get_friendly_app_name(self, window_title: str, process_name: str) -> str:
        """Get a friendly application name from window title and process name."""
        try:
            # Common application mappings
            app_mappings = {
                'python.exe': 'Python',
                'cursor.exe': 'Cursor',
                'code.exe': 'Visual Studio Code',
                'notepad.exe': 'Notepad',
                'wordpad.exe': 'WordPad',
                'calc.exe': 'Calculator',
                'mspaint.exe': 'Paint',
                'chrome.exe': 'Chrome',
                'firefox.exe': 'Firefox',
                'msedge.exe': 'Edge',
                'iexplore.exe': 'Internet Explorer',
                'outlook.exe': 'Outlook',
                'winword.exe': 'Microsoft Word',
                'excel.exe': 'Microsoft Excel',
                'powerpnt.exe': 'Microsoft PowerPoint',
                'onenote.exe': 'OneNote',
                'teams.exe': 'Microsoft Teams',
                'slack.exe': 'Slack',
                'discord.exe': 'Discord',
                'zoom.exe': 'Zoom',
                'skype.exe': 'Skype',
                'explorer.exe': 'File Explorer',
                'taskmgr.exe': 'Task Manager',
                'regedit.exe': 'Registry Editor',
                'cmd.exe': 'Command Prompt',
                'powershell.exe': 'PowerShell',
                'git-bash.exe': 'Git Bash',
                'putty.exe': 'PuTTY',
                'winrar.exe': 'WinRAR',
                '7zfm.exe': '7-Zip',
                'acrobat.exe': 'Adobe Acrobat',
                'photoshop.exe': 'Adobe Photoshop',
                'illustrator.exe': 'Adobe Illustrator',
                'premiere.exe': 'Adobe Premiere',
                'afterfx.exe': 'After Effects',
                'figma.exe': 'Figma',
                'sketch.exe': 'Sketch',
                'invision.exe': 'InVision',
                'zeplin.exe': 'Zeplin',
                'intellij64.exe': 'IntelliJ IDEA',
                'idea64.exe': 'IntelliJ IDEA',
                'eclipse.exe': 'Eclipse',
                'netbeans64.exe': 'NetBeans',
                'sublime_text.exe': 'Sublime Text',
                'atom.exe': 'Atom',
                'brackets.exe': 'Brackets',
                'notepad++.exe': 'Notepad++',
                'vim.exe': 'Vim',
                'emacs.exe': 'Emacs',
                'node.exe': 'Node.js',
                'npm.exe': 'npm',
                'yarn.exe': 'Yarn',
                'docker.exe': 'Docker',
                'postman.exe': 'Postman',
                'insomnia.exe': 'Insomnia',
                'soapui.exe': 'SoapUI',
                'jmeter.exe': 'Apache JMeter',
                'wireshark.exe': 'Wireshark',
                'fiddler.exe': 'Fiddler',
                'charles.exe': 'Charles Proxy',
                'burpsuite.exe': 'Burp Suite',
                'metasploit.exe': 'Metasploit',
                'nmap.exe': 'Nmap',
                'wireshark.exe': 'Wireshark',
                'virtualbox.exe': 'VirtualBox',
                'vmware.exe': 'VMware',
                'hyperv.exe': 'Hyper-V',
                'docker.exe': 'Docker',
                'kubernetes.exe': 'Kubernetes',
                'terraform.exe': 'Terraform',
                'ansible.exe': 'Ansible',
                'jenkins.exe': 'Jenkins',
                'gitlab.exe': 'GitLab',
                'github.exe': 'GitHub Desktop',
                'bitbucket.exe': 'Bitbucket',
                'jira.exe': 'Jira',
                'confluence.exe': 'Confluence',
                'trello.exe': 'Trello',
                'asana.exe': 'Asana',
                'monday.exe': 'Monday.com',
                'clickup.exe': 'ClickUp',
                'notion.exe': 'Notion',
                'evernote.exe': 'Evernote',
                'onenote.exe': 'OneNote',
                'obsidian.exe': 'Obsidian',
                'roam.exe': 'Roam Research',
                'logseq.exe': 'Logseq',
                'remnote.exe': 'RemNote',
                'craft.exe': 'Craft',
                'bear.exe': 'Bear',
                'ulysses.exe': 'Ulysses',
                'scrivener.exe': 'Scrivener',
                'grammarly.exe': 'Grammarly',
                'hemingway.exe': 'Hemingway Editor',
                'prowritingaid.exe': 'ProWritingAid',
                'ginger.exe': 'Ginger',
                'languagetool.exe': 'LanguageTool',
                'whiteboard.exe': 'Microsoft Whiteboard',
                'mural.exe': 'Mural',
                'miro.exe': 'Miro',
                'figjam.exe': 'Figma Jam',
                'whimsical.exe': 'Whimsical',
                'lucidchart.exe': 'Lucidchart',
                'draw.io.exe': 'Draw.io',
                'visio.exe': 'Microsoft Visio',
                'balsamiq.exe': 'Balsamiq',
                'axure.exe': 'Axure RP',
                'invision.exe': 'InVision',
                'marvel.exe': 'Marvel',
                'principle.exe': 'Principle',
                'framer.exe': 'Framer',
                'webflow.exe': 'Webflow',
                'bubble.exe': 'Bubble',
                'glide.exe': 'Glide',
                'adalo.exe': 'Adalo',
                'thunkable.exe': 'Thunkable',
                'appgyver.exe': 'AppGyver',
                'retool.exe': 'Retool',
                'airtable.exe': 'Airtable',
                'notion.exe': 'Notion',
                'coda.exe': 'Coda',
                'clickup.exe': 'ClickUp',
                'monday.exe': 'Monday.com',
                'asana.exe': 'Asana',
                'trello.exe': 'Trello',
                'jira.exe': 'Jira',
                'confluence.exe': 'Confluence',
                'slack.exe': 'Slack',
                'discord.exe': 'Discord',
                'teams.exe': 'Microsoft Teams',
                'zoom.exe': 'Zoom',
                'skype.exe': 'Skype',
                'webex.exe': 'Cisco Webex',
                'gotomeeting.exe': 'GoToMeeting',
                'bluejeans.exe': 'BlueJeans',
                'ringcentral.exe': 'RingCentral',
                '8x8.exe': '8x8',
                'dialpad.exe': 'Dialpad',
                'grasshopper.exe': 'Grasshopper',
                'phone.com.exe': 'Phone.com',
                'nextiva.exe': 'Nextiva',
                'ooma.exe': 'Ooma',
                'vonage.exe': 'Vonage',
                'twilio.exe': 'Twilio',
                'plivo.exe': 'Plivo',
                'bandwidth.exe': 'Bandwidth',
                'messagebird.exe': 'MessageBird',
                'sendgrid.exe': 'SendGrid',
                'mailgun.exe': 'Mailgun',
                'postmark.exe': 'Postmark',
                'mailchimp.exe': 'Mailchimp',
                'constantcontact.exe': 'Constant Contact',
                'campaignmonitor.exe': 'Campaign Monitor',
                'convertkit.exe': 'ConvertKit',
                'drip.exe': 'Drip',
                'klaviyo.exe': 'Klaviyo',
                'activecampaign.exe': 'ActiveCampaign',
                'hubspot.exe': 'HubSpot',
                'salesforce.exe': 'Salesforce',
                'pipedrive.exe': 'Pipedrive',
                'zoho.exe': 'Zoho',
                'freshsales.exe': 'Freshsales',
                'insightly.exe': 'Insightly',
                'nimble.exe': 'Nimble',
                'contactually.exe': 'Contactually',
                'streak.exe': 'Streak',
                'copper.exe': 'Copper',
                'close.exe': 'Close',
                'outreach.exe': 'Outreach',
                'salesloft.exe': 'SalesLoft',
                'apollo.exe': 'Apollo',
                'zoominfo.exe': 'ZoomInfo',
                'linkedin.exe': 'LinkedIn',
                'twitter.exe': 'Twitter',
                'facebook.exe': 'Facebook',
                'instagram.exe': 'Instagram',
                'tiktok.exe': 'TikTok',
                'youtube.exe': 'YouTube',
                'twitch.exe': 'Twitch',
                'reddit.exe': 'Reddit',
                'pinterest.exe': 'Pinterest',
                'snapchat.exe': 'Snapchat',
                'whatsapp.exe': 'WhatsApp',
                'telegram.exe': 'Telegram',
                'signal.exe': 'Signal',
                'wechat.exe': 'WeChat',
                'line.exe': 'Line',
                'viber.exe': 'Viber',
                'kik.exe': 'Kik',
                'discord.exe': 'Discord',
                'slack.exe': 'Slack',
                'teams.exe': 'Microsoft Teams',
                'zoom.exe': 'Zoom',
                'skype.exe': 'Skype',
                'webex.exe': 'Cisco Webex',
                'gotomeeting.exe': 'GoToMeeting',
                'bluejeans.exe': 'BlueJeans',
                'ringcentral.exe': 'RingCentral',
                '8x8.exe': '8x8',
                'dialpad.exe': 'Dialpad',
                'grasshopper.exe': 'Grasshopper',
                'phone.com.exe': 'Phone.com',
                'nextiva.exe': 'Nextiva',
                'ooma.exe': 'Ooma',
                'vonage.exe': 'Vonage',
                'twilio.exe': 'Twilio',
                'plivo.exe': 'Plivo',
                'bandwidth.exe': 'Bandwidth',
                'messagebird.exe': 'MessageBird',
                'sendgrid.exe': 'SendGrid',
                'mailgun.exe': 'Mailgun',
                'postmark.exe': 'Postmark',
                'mailchimp.exe': 'Mailchimp',
                'constantcontact.exe': 'Constant Contact',
                'campaignmonitor.exe': 'Campaign Monitor',
                'convertkit.exe': 'ConvertKit',
                'drip.exe': 'Drip',
                'klaviyo.exe': 'Klaviyo',
                'activecampaign.exe': 'ActiveCampaign',
                'hubspot.exe': 'HubSpot',
                'salesforce.exe': 'Salesforce',
                'pipedrive.exe': 'Pipedrive',
                'zoho.exe': 'Zoho',
                'freshsales.exe': 'Freshsales',
                'insightly.exe': 'Insightly',
                'nimble.exe': 'Nimble',
                'contactually.exe': 'Contactually',
                'streak.exe': 'Streak',
                'copper.exe': 'Copper',
                'close.exe': 'Close',
                'outreach.exe': 'Outreach',
                'salesloft.exe': 'SalesLoft',
                'apollo.exe': 'Apollo',
                'zoominfo.exe': 'ZoomInfo',
                'linkedin.exe': 'LinkedIn',
                'twitter.exe': 'Twitter',
                'facebook.exe': 'Facebook',
                'instagram.exe': 'Instagram',
                'tiktok.exe': 'TikTok',
                'youtube.exe': 'YouTube',
                'twitch.exe': 'Twitch',
                'reddit.exe': 'Reddit',
                'pinterest.exe': 'Pinterest',
                'snapchat.exe': 'Snapchat',
                'whatsapp.exe': 'WhatsApp',
                'telegram.exe': 'Telegram',
                'signal.exe': 'Signal',
                'wechat.exe': 'WeChat',
                'line.exe': 'Line',
                'viber.exe': 'Viber',
                'kik.exe': 'Kik'
            }
            
            # First, try to get friendly name from process name mapping
            if process_name.lower() in app_mappings:
                return app_mappings[process_name.lower()]
            
            # For Cursor specifically, check window title
            if 'cursor' in window_title.lower() or 'cursor' in process_name.lower():
                return 'Cursor'
            
            # For VS Code, check window title
            if 'visual studio code' in window_title.lower() or 'code' in process_name.lower():
                return 'Visual Studio Code'
            
            # For browsers, check window title
            if any(browser in window_title.lower() for browser in ['chrome', 'firefox', 'edge', 'safari']):
                if 'chrome' in window_title.lower():
                    return 'Chrome'
                elif 'firefox' in window_title.lower():
                    return 'Firefox'
                elif 'edge' in window_title.lower():
                    return 'Edge'
                elif 'safari' in window_title.lower():
                    return 'Safari'
            
            # For Office applications, check window title
            if 'microsoft word' in window_title.lower():
                return 'Microsoft Word'
            elif 'microsoft excel' in window_title.lower():
                return 'Microsoft Excel'
            elif 'microsoft powerpoint' in window_title.lower():
                return 'Microsoft PowerPoint'
            elif 'microsoft outlook' in window_title.lower():
                return 'Microsoft Outlook'
            
            # If no mapping found, try to extract from window title
            if window_title:
                # Remove common suffixes
                clean_title = window_title
                suffixes = [' - Google Chrome', ' - Mozilla Firefox', ' - Microsoft Edge', 
                           ' - Visual Studio Code', ' - Cursor', ' - Notepad', ' - Calculator']
                for suffix in suffixes:
                    if clean_title.endswith(suffix):
                        clean_title = clean_title.replace(suffix, '')
                        break
                
                # If the clean title is reasonable, use it
                if len(clean_title) > 0 and len(clean_title) < 50:
                    return clean_title
            
            # Fallback to process name without .exe
            return process_name.replace('.exe', '').title()
            
        except Exception as e:
            # Fallback to process name
            return process_name.replace('.exe', '').title()
    
    def _track_web_activity(self, current_time: datetime):
        """Track web browser activity with enhanced URL and domain extraction."""
        try:
            # Get foreground window
            hwnd = win32gui.GetForegroundWindow()
            window_title = win32gui.GetWindowText(hwnd)
            
            # Check if it's a browser window
            browser_detected = False
            browser_name = None
            
            for browser in ['chrome', 'firefox', 'edge', 'safari']:
                if browser in window_title.lower():
                    browser_detected = True
                    browser_name = browser
                    break
            
            if browser_detected:
                # Enhanced URL and domain extraction
                url, domain, page_title = self._extract_web_info(window_title, browser_name)
                
                if url and not any(blacklisted in url.lower() for blacklisted in BLACKLISTED_URLS):
                    # Create a unique key for this web activity
                    web_key = f"{domain}_{page_title}" if domain and page_title else url
                    
                    if web_key not in self.web_activity:
                        self.web_activity[web_key] = {
                            'url': url,
                            'domain': domain,
                            'page_title': page_title,
                            'duration': 0,
                            'browser': browser_name
                        }
                    
                    self.web_activity[web_key]['duration'] += ACTIVITY_CHECK_INTERVAL
                    
                    # Log web activity with enhanced details
                    log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                    activity_logger.info(f"Web activity detected: {domain} - {page_title}", 
                                       employee_id=log_id,
                                       url=url,
                                       domain=domain,
                                       page_title=page_title,
                                       browser=browser_name,
                                       duration=self.web_activity[web_key]['duration'])
        
        except Exception as e:
            # Use employee_uuid for logging if available, otherwise fall back to employee_id
            log_id = self.employee_uuid if self.employee_uuid else self.employee_id
            activity_logger.error("Error tracking web activity", error=str(e), employee_id=log_id)
    
    def _extract_web_info(self, window_title: str, browser_name: str):
        """Extract URL, domain, and page title from browser window title with enhanced video detection."""
        try:
            url = None
            domain = None
            page_title = None
            
            # Different browsers have different title formats
            if browser_name == 'chrome':
                # Chrome: "Page Title - Website - Google Chrome"
                if ' - Google Chrome' in window_title:
                    parts = window_title.replace(' - Google Chrome', '').split(' - ')
                    if len(parts) >= 2:
                        page_title = parts[0]
                        url = parts[1]
                        # Ensure URL has protocol
                        if url and not url.startswith(('http://', 'https://')):
                            url = f"https://{url}"
                    elif len(parts) == 1:
                        page_title = parts[0]
                        # If no URL found, try to extract domain from title or use a placeholder
                        if parts[0] and '.' in parts[0]:
                            # Might be a domain in the title
                            url = f"https://{parts[0]}"
                        else:
                            url = "https://unknown.com"
            
            elif browser_name == 'firefox':
                # Firefox: "Page Title - Website - Mozilla Firefox"
                if ' - Mozilla Firefox' in window_title:
                    parts = window_title.replace(' - Mozilla Firefox', '').split(' - ')
                    if len(parts) >= 2:
                        page_title = parts[0]
                        url = parts[1]
                        if url and not url.startswith(('http://', 'https://')):
                            url = f"https://{url}"
                    elif len(parts) == 1:
                        page_title = parts[0]
                        if parts[0] and '.' in parts[0]:
                            url = f"https://{parts[0]}"
                        else:
                            url = "https://unknown.com"
            
            elif browser_name == 'edge':
                # Edge: "Page Title - Website - Microsoft Edge"
                if ' - Microsoft Edge' in window_title:
                    parts = window_title.replace(' - Microsoft Edge', '').split(' - ')
                    if len(parts) >= 2:
                        page_title = parts[0]
                        url = parts[1]
                        if url and not url.startswith(('http://', 'https://')):
                            url = f"https://{url}"
                    elif len(parts) == 1:
                        page_title = parts[0]
                        if parts[0] and '.' in parts[0]:
                            url = f"https://{parts[0]}"
                        else:
                            url = "https://unknown.com"
            
            # Extract domain from URL
            if url:
                # Remove protocol if present
                if '://' in url:
                    domain = url.split('://')[1].split('/')[0]
                else:
                    domain = url.split('/')[0]
                
                # Remove www. prefix
                if domain.startswith('www.'):
                    domain = domain[4:]
                
                # Handle special cases
                if domain in ['localhost', '127.0.0.1']:
                    domain = 'localhost'
            
            # Enhanced video title detection
            if page_title and domain:
                # YouTube video detection
                if 'youtube.com' in domain or 'youtu.be' in domain:
                    # YouTube titles often include " - YouTube" at the end
                    if page_title.endswith(' - YouTube'):
                        page_title = page_title.replace(' - YouTube', '')
                    # Also check for channel names in brackets
                    if ' - ' in page_title and not page_title.endswith(' - YouTube'):
                        # This might be "Video Title - Channel Name"
                        parts = page_title.split(' - ')
                        if len(parts) >= 2:
                            # Keep the video title, remove channel name
                            page_title = parts[0]
                
                # Netflix detection
                elif 'netflix.com' in domain:
                    if page_title.endswith(' - Netflix'):
                        page_title = page_title.replace(' - Netflix', '')
                
                # Hulu detection
                elif 'hulu.com' in domain:
                    if page_title.endswith(' - Hulu'):
                        page_title = page_title.replace(' - Hulu', '')
                
                # Disney+ detection
                elif 'disneyplus.com' in domain:
                    if page_title.endswith(' - Disney+'):
                        page_title = page_title.replace(' - Disney+', '')
                
                # Amazon Prime Video detection
                elif 'amazon.com' in domain and 'prime' in page_title.lower():
                    if page_title.endswith(' - Amazon.com'):
                        page_title = page_title.replace(' - Amazon.com', '')
                
                # Vimeo detection
                elif 'vimeo.com' in domain:
                    if page_title.endswith(' - Vimeo'):
                        page_title = page_title.replace(' - Vimeo', '')
                
                # Twitch detection
                elif 'twitch.tv' in domain:
                    if page_title.endswith(' - Twitch'):
                        page_title = page_title.replace(' - Twitch', '')
                
                # General video platform cleanup
                video_platforms = [' - YouTube', ' - Netflix', ' - Hulu', ' - Disney+', 
                                 ' - Amazon.com', ' - Vimeo', ' - Twitch', ' - Dailymotion']
                for platform in video_platforms:
                    if page_title.endswith(platform):
                        page_title = page_title.replace(platform, '')
                        break
            
            # Log enhanced web info extraction
            log_id = self.employee_uuid if self.employee_uuid else self.employee_id
            activity_logger.info(f"Enhanced web info extracted: Title='{page_title}', Domain='{domain}', URL='{url}'", 
                               employee_id=log_id)
            
            return url, domain, page_title
            
        except Exception as e:
            log_id = self.employee_uuid if self.employee_uuid else self.employee_id
            activity_logger.error("Error extracting web info", error=str(e), employee_id=log_id)
            return None, None, None
    
    def _on_mouse_move(self, x, y):
        """Handle mouse movement."""
        self._update_activity()
        self.mouse_activity["movements"] += 1
    
    def _on_mouse_click(self, x, y, button, pressed):
        """Handle mouse clicks."""
        self._update_activity()
        if pressed:
            self.mouse_activity["clicks"] += 1
    
    def _on_mouse_scroll(self, x, y, dx, dy):
        """Handle mouse scrolling."""
        self._update_activity()
        self.mouse_activity["scrolls"] += 1
        
        if TRACK_SCROLLING:
            activity_logger.log_activity(
                self.employee_uuid if self.employee_uuid else self.employee_id,
                "scroll",
                {"direction": "up" if dy > 0 else "down", "amount": abs(dy)},
                datetime.now()
            )
    
    def _on_key_press(self, key):
        """Handle key press."""
        self._update_activity()
        self.keyboard_activity["keystrokes"] += 1
    
    def _on_key_release(self, key):
        """Handle key release."""
        pass
    
    def _update_activity(self):
        """Update last activity timestamp."""
        self.last_activity = datetime.now()
        
        # Show project dialog if no project is selected
        if self.current_project is None and self.project_manager:
            self._show_project_dialog()
    
    def _show_project_dialog(self):
        """Show project selection dialog in a separate thread to avoid blocking."""
        def show_dialog():
            try:
                selected_project = self.project_manager.show_project_dialog()
                if selected_project:
                    self.switch_project(selected_project)
                    activity_logger.info(f"Project selected: {selected_project}", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
                else:
                    # If no project selected, use Default
                    self.switch_project("Default")
                    activity_logger.info("No project selected, using Default", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
            except Exception as e:
                activity_logger.error(f"Error showing project dialog: {e}", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
                # Fallback to Default project
                self.switch_project("Default")
        
        # Run dialog in a separate thread to avoid blocking the tracking
        dialog_thread = threading.Thread(target=show_dialog, daemon=True)
        dialog_thread.start()
    
    def switch_project(self, project_name: str):
        """Switch to a different project."""
        old_project = self.current_project
        self.current_project = project_name
        
        current_time = datetime.now()
        self.project_switches.append({
            "from": old_project,
            "to": project_name,
            "timestamp": current_time.isoformat()
        })
        
        activity_logger.log_project_switch(
            self.employee_uuid if self.employee_uuid else self.employee_id,
            old_project,
            project_name,
            current_time
        )
    
    def get_activity_summary(self) -> Dict:
        """Get current activity summary."""
        current_time = datetime.now()
        idle_duration = 0
        
        if self.idle_start:
            idle_duration = (current_time - self.idle_start).total_seconds()
        
        return {
            "employee_id": self.employee_uuid if self.employee_uuid else self.employee_id,
            "timestamp": current_time.isoformat(),
            "is_idle": idle_duration > IDLE_THRESHOLD,
            "idle_duration": int(idle_duration),
            "current_app": self.current_app,
            "current_project": self.current_project,
            "app_usage": self.app_usage.copy(),
            "web_activity": self.web_activity.copy(),
            "mouse_activity": self.mouse_activity.copy(),
            "keyboard_activity": self.keyboard_activity.copy(),
            "project_switches": self.project_switches.copy()
        }
    
    def reset_daily_stats(self):
        """Reset daily statistics."""
        self.app_usage = {}
        self.web_activity = {}
        self.mouse_activity = {"clicks": 0, "scrolls": 0, "movements": 0}
        self.keyboard_activity = {"keystrokes": 0, "typing_time": 0}
        self.project_switches = []
        
        activity_logger.info("Daily stats reset", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
    
    def _sync_data_to_supabase(self, current_time: datetime):
        """Sync collected data to Supabase."""
        try:
            if not self.supabase_manager:
                activity_logger.info("No Supabase manager available, skipping sync", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
                return
            
            if not self.employee_uuid:
                activity_logger.warning("No employee UUID available, skipping sync", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
                return
            
            activity_logger.info("Starting data sync to Supabase", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
            
            # Get employee organization from the current session
            organization_id = None
            if self.supabase_manager.current_employee:
                organization_id = self.supabase_manager.current_employee['organization_id']
            
            if not organization_id:
                activity_logger.warning("No organization ID available, skipping sync", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
                return
            
            # Sync activity log
            activity_data = {
                "employee_id": self.employee_uuid,  # Use UUID instead of string ID
                "organization_id": organization_id,
                "timestamp": current_time.isoformat(),
                "activity_type": "general",
                "details": {
                    "current_app": self.current_app,
                    "current_project": self.current_project,
                    "is_idle": self.idle_start is not None,
                    "mouse_clicks": self.mouse_activity["clicks"],
                    "mouse_scrolls": self.mouse_activity["scrolls"],
                    "keyboard_keystrokes": self.keyboard_activity["keystrokes"]
                }
            }
            
            success = self.supabase_manager.sync_activity_data(activity_data)
            activity_logger.info(f"Activity data sync {'successful' if success else 'failed'}", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
            
            # Create a "current activity" record for real-time visibility (separate from session tracking)
            # This shows what the user is currently doing without affecting session duration calculations
            if self.current_app and self.current_app not in BLACKLISTED_APPS:
                # Calculate current session duration for display purposes
                current_app_duration = 0
                if self.current_app in self.active_app_sessions:
                    session_start = self.active_app_sessions[self.current_app]
                    current_app_duration = int((current_time - session_start).total_seconds())
                
                # Create current activity record (this is for real-time display, not session tracking)
                current_activity_data = {
                    "employee_id": self.employee_uuid,
                    "organization_id": organization_id,
                    "app_name": self.current_app,
                    "window_title": self.current_app,  # Could be enhanced to get actual window title
                    "duration_seconds": current_app_duration,
                    "start_time": self.active_app_sessions.get(self.current_app, current_time).isoformat(),
                    "end_time": None,  # Active session, no end time yet
                    "is_active": True
                }
                
                success = self.supabase_manager.sync_current_activity(current_activity_data)
                activity_logger.info(f"Current activity sync for {self.current_app}: {'successful' if success else 'failed'}", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
            
            # Only create app usage record for the current active app (not all apps that have been used)
            # This prevents creating multiple records for minimized apps
            if self.current_app and self.current_app not in BLACKLISTED_APPS:
                # Calculate current session duration for display purposes
                current_app_duration = 0
                if self.current_app in self.active_app_sessions:
                    session_start = self.active_app_sessions[self.current_app]
                    current_app_duration = int((current_time - session_start).total_seconds())
                
                # Create app usage record only for the current active app
                app_usage_data = {
                    "employee_id": self.employee_uuid,
                    "organization_id": organization_id,
                    "app_name": self.current_app,
                    "window_title": self.current_app,
                    "duration_seconds": current_app_duration,
                    "start_time": self.active_app_sessions.get(self.current_app, current_time).isoformat(),
                    "end_time": None,  # Active session, no end time yet
                    "is_active": True,
                    "current_project": self.current_project  # Add project information
                }
                
                success = self.supabase_manager.sync_app_usage(app_usage_data)
                activity_logger.info(f"App usage sync for current app {self.current_app}: {'successful' if success else 'failed'}", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
            
            # Sync web activity data
            web_activity_synced = []
            for web_key, web_data in self.web_activity.items():
                if web_data['duration'] >= 10:  # Reduced from 30 to 10 seconds for more responsive tracking
                    web_sync_data = {
                        "employee_id": self.employee_uuid,  # Use UUID instead of string ID
                        "organization_id": organization_id,
                        "url": web_data['url'],
                        "domain": web_data['domain'],
                        "title": web_data['page_title'],
                        "duration_seconds": web_data['duration'],
                        "start_time": current_time.isoformat(),
                        "current_project": self.current_project  # Add project information
                    }
                    success = self.supabase_manager.sync_web_activity(web_sync_data)
                    activity_logger.info(f"Web activity sync for {web_data['domain']} - {web_data['page_title']} (Project: {self.current_project}): {'successful' if success else 'failed'}", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
                    if success:
                        web_activity_synced.append(web_key)
            
            # Only remove web activity that was successfully synced
            for web_key in web_activity_synced:
                del self.web_activity[web_key]
            
            # Reset counters after sync (but keep active app sessions and web activity)
            # Note: app_usage is NOT reset here - it accumulates until apps are closed
            self.mouse_activity = {"clicks": 0, "scrolls": 0, "movements": 0}
            self.keyboard_activity = {"keystrokes": 0, "typing_time": 0}
            
            activity_logger.info("Data sync completed", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
            
        except Exception as e:
            activity_logger.error("Error syncing data to Supabase", error=str(e), employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
    
    def _check_closed_apps(self, current_time: datetime):
        """Check for apps that have been closed and end their sessions."""
        try:
            # Get all running processes
            running_processes = set()
            for proc in psutil.process_iter(['pid', 'name']):
                try:
                    if proc.info['name'] not in BLACKLISTED_APPS:
                        running_processes.add(proc.info['name'])
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            
            # Check which tracked apps are no longer running
            closed_apps = []
            for app_name in list(self.active_app_sessions.keys()):
                if app_name not in running_processes:
                    closed_apps.append(app_name)
            
            # End sessions for closed apps
            for app_name in closed_apps:
                session_start = self.active_app_sessions[app_name]
                session_duration = (current_time - session_start).total_seconds()
                
                # Log the end of the app session
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.info(f"App session ended: {app_name}", 
                                   employee_id=log_id,
                                   app_name=app_name,
                                   session_duration=int(session_duration),
                                   session_start=session_start.isoformat(),
                                   session_end=current_time.isoformat())
                
                # Remove from active sessions
                del self.active_app_sessions[app_name]
                
                # Create app usage record for the completed session
                if self.supabase_manager and self.employee_uuid:
                    organization_id = None
                    if self.supabase_manager.current_employee:
                        organization_id = self.supabase_manager.current_employee['organization_id']
                    
                    if organization_id:
                        app_data = {
                            "employee_id": self.employee_uuid,
                            "organization_id": organization_id,
                            "app_name": app_name,
                            "duration_seconds": int(session_duration),
                            "start_time": session_start.isoformat(),
                            "end_time": current_time.isoformat(),
                            "is_active": False,
                            "current_project": self.current_project  # Add project information
                        }
                        success = self.supabase_manager.sync_app_usage(app_data)
                        activity_logger.info(f"App session recorded for {app_name}: {'successful' if success else 'failed'}", 
                                           employee_id=log_id)
                
        except Exception as e:
            log_id = self.employee_uuid if self.employee_uuid else self.employee_id
            activity_logger.error("Error checking closed apps", error=str(e), employee_id=log_id)
    
    def _update_current_activity_record(self, current_time: datetime):
        """Update the current activity record when an app switch is detected."""
        try:
            if not self.supabase_manager or not self.employee_uuid:
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.warning("Cannot update current activity: no supabase manager or employee UUID", employee_id=log_id)
                return
            
            # Get employee organization from the current session
            organization_id = None
            if self.supabase_manager.current_employee:
                organization_id = self.supabase_manager.current_employee['organization_id']
            
            if not organization_id:
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.warning("Cannot update current activity: no organization ID", employee_id=log_id)
                return
            
            if self.current_app and self.current_app not in BLACKLISTED_APPS:
                # Calculate current session duration for display purposes
                current_app_duration = 0
                if self.current_app in self.active_app_sessions:
                    session_start = self.active_app_sessions[self.current_app]
                    current_app_duration = int((current_time - session_start).total_seconds())
                
                # Create current activity record (this is for real-time display, not session tracking)
                current_activity_data = {
                    "employee_id": self.employee_uuid,
                    "organization_id": organization_id,
                    "app_name": self.current_app,
                    "window_title": self.current_app,  # Could be enhanced to get actual window title
                    "duration_seconds": current_app_duration,
                    "start_time": self.active_app_sessions.get(self.current_app, current_time).isoformat(),
                    "end_time": None,  # Active session, no end time yet
                    "is_active": True
                }
                
                log_id = self.employee_uuid if self.employee_uuid else self.employee_id
                activity_logger.info(f"📤 Sending current activity update: {self.current_app} (duration: {current_app_duration}s)", employee_id=log_id)
                
                success = self.supabase_manager.sync_current_activity(current_activity_data)
                activity_logger.info(f"Current activity sync for {self.current_app}: {'successful' if success else 'failed'}", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
            else:
                activity_logger.info("Current app is blacklisted or not active, skipping current activity sync", employee_id=self.employee_uuid if self.employee_uuid else self.employee_id)
                
        except Exception as e:
            log_id = self.employee_uuid if self.employee_uuid else self.employee_id
            activity_logger.error("Error updating current activity record", error=str(e), employee_id=log_id) 