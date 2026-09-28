using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Forms;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace CastFlow.Manager
{
    public class Program
    {
        [STAThread]
        public static void Main()
        {
            // 单实例防重开
            bool createdNew;
            using (var mutex = new System.Threading.Mutex(true, "CastFlowManager_SingleInstance_Mutex_Global", out createdNew))
            {
                if (!createdNew)
                {
                    return;
                }

                try
                {
                    TaskScheduler.UnobservedTaskException += (s, e) =>
                    {
                        e.SetObserved();
                    };

                    var app = new System.Windows.Application();
                    app.ShutdownMode = ShutdownMode.OnExplicitShutdown;

                    app.DispatcherUnhandledException += (s, e) =>
                    {
                        e.Handled = true;
                    };

                    var window = new MainWindow();
                    window.Show();
                    app.Run();
                }
                catch (Exception ex)
                {
                    System.Windows.MessageBox.Show("CastFlow 管理器启动异常: " + ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }
    }

    public class MainWindow : Window
    {
        private NotifyIcon _trayIcon;
        private readonly DispatcherTimer _pollTimer;
        private readonly HttpClient _http;
        private readonly string _appRoot;
        private int _port = 18089;

        // UI 元素 - 核心状态区
        private Border _tagService;
        private TextBlock _txtServiceTag;
        private TextBlock _txtServicePid;
        private TextBlock _txtServicePort;

        private Border _tagChrome;
        private TextBlock _txtChromeTag;
        private TextBlock _txtChromeTabs;

        private TextBlock _txtAccessUrl;

        // UI 元素 - 默认启动页配置
        private string _startUrl = "about:blank";
        private System.Windows.Controls.TextBox _txtStartUrl;
        private System.Windows.Controls.Button _btnSaveStartUrl;

        // UI 元素 - 详细信息区
        private TextBlock _txtRunMode;
        private TextBlock _txtNodeVer;
        private TextBlock _txtNodePath;
        private TextBlock _txtChromeVer;
        private TextBlock _txtChromePath;
        private TextBlock _txtAppDir;
        private TextBlock _txtMemoryInfo;
        private System.Windows.Controls.ProgressBar _pbMemory;
        private TextBlock _txtSysMemory;
        private TextBlock _txtWatchdog;

        // UI 元素 - 操作按钮
        private System.Windows.Controls.Button _btnStart;
        private System.Windows.Controls.Button _btnStop;
        private System.Windows.Controls.Button _btnRestart;
        private System.Windows.Controls.Button _btnAutoStart;
        private System.Windows.Controls.Button _btnViewLog;
        private System.Windows.Controls.Button _btnTimedShutdown;

        private TextBlock _txtHint;
        private bool _isChecking = false;

        // 本地检测缓存
        private string _cachedNodePath = "--";
        private string _cachedNodeVer = "--";
        private string _cachedChromePath = "--";
        private string _cachedChromeVer = "--";
        private string _browserType = "none";
        private System.Windows.Controls.Button _btnDownloadChrome;
        private bool _isPackaged = false;
        private bool _autoStartOn = false;
        private string _shutdownInfo = "关";
        private int _currentServerPid = 0;

        // 在线更新状态
        private const string CURRENT_VERSION = "v1.0.1";
        private string _latestVersionTag = null;
        private string _installerDownloadUrl = null;
        private TextBlock _txtVersion;
        private Border _btnUpdate;
        private TextBlock _txtUpdateIcon;
        private bool _isDownloadingUpdate = false;

        public MainWindow()
        {
            _appRoot = AppDomain.CurrentDomain.BaseDirectory;
            _port = ResolveConfigPort();
            _startUrl = ResolveConfigStartUrl();
            _http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };

            DetectLocalEnvironment();

            InitWindow();
            InitTray();
            ApplyAppIcon();

            _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.5) };
            _pollTimer.Tick += async (s, e) => await CheckStatusAsync();
            _pollTimer.Start();

            Loaded += async (s, e) =>
            {
                await CheckStatusAsync();
                var bgUpdate = Task.Run(async () =>
                {
                    await Task.Delay(2000);
                    await CheckForUpdatesSilentlyAsync();
                });
            };
        }

        private int ResolveConfigPort()
        {
            try
            {
                string cfgPath = System.IO.Path.Combine(_appRoot, "config.json");
                if (File.Exists(cfgPath))
                {
                    string json = File.ReadAllText(cfgPath);
                    int p = ParseJsonInt(json, "port", 18089);
                    if (p > 0 && p <= 65535) return p;
                }
            }
            catch { }
            return 18089;
        }

        private string ResolveConfigStartUrl()
        {
            try
            {
                string cfgPath = System.IO.Path.Combine(_appRoot, "config.json");
                if (File.Exists(cfgPath))
                {
                    string json = File.ReadAllText(cfgPath);
                    string url = ExtractJsonValue(json, "startUrl");
                    if (!string.IsNullOrEmpty(url)) return url.Trim();
                }
            }
            catch { }
            return "about:blank";
        }

        private void DetectLocalEnvironment()
        {
            _isPackaged = File.Exists(System.IO.Path.Combine(_appRoot, "CastFlow.exe"));

            // 查找 Chrome 和 Edge
            string foundChrome = FindChromeExecutable();
            string foundEdge = FindEdgeExecutable();

            if (!string.IsNullOrEmpty(foundChrome) && File.Exists(foundChrome))
            {
                _cachedChromePath = foundChrome;
                try
                {
                    var vi = FileVersionInfo.GetVersionInfo(foundChrome);
                    _cachedChromeVer = "Google Chrome v" + (vi.ProductVersion ?? vi.FileVersion ?? "已安装");
                }
                catch { _cachedChromeVer = "Google Chrome (已安装)"; }
                _browserType = "chrome";
            }
            else if (!string.IsNullOrEmpty(foundEdge) && File.Exists(foundEdge))
            {
                _cachedChromePath = foundEdge;
                try
                {
                    var vi = FileVersionInfo.GetVersionInfo(foundEdge);
                    _cachedChromeVer = "Microsoft Edge v" + (vi.ProductVersion ?? vi.FileVersion ?? "已安装") + " (系统备选)";
                }
                catch { _cachedChromeVer = "Microsoft Edge (系统备选)"; }
                _browserType = "edge";
            }
            else
            {
                _cachedChromePath = "未安装";
                _cachedChromeVer = "未检测到 (需安装 Chrome)";
                _browserType = "none";
            }

            // 查找 Node
            if (_isPackaged)
            {
                _cachedNodePath = System.IO.Path.Combine(_appRoot, "CastFlow.exe");
                _cachedNodeVer = "内置 Node 运行时";
            }
            else
            {
                try
                {
                    string pFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                    string np = System.IO.Path.Combine(pFiles, @"nodejs\node.exe");
                    if (File.Exists(np))
                    {
                        _cachedNodePath = np;
                        var vi = FileVersionInfo.GetVersionInfo(np);
                        _cachedNodeVer = "v" + (vi.ProductVersion ?? vi.FileVersion ?? "未知");
                    }
                }
                catch { }
            }

            CheckScheduledTasks();
        }

        private void CheckScheduledTasks()
        {
            try
            {
                var psi = new ProcessStartInfo("schtasks", "/query /tn \"CastFlow\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true
                };
                var p = Process.Start(psi);
                p.WaitForExit(800);
                _autoStartOn = (p.ExitCode == 0);
            }
            catch { _autoStartOn = false; }

            try
            {
                var psi = new ProcessStartInfo("schtasks", "/query /tn \"CastFlowShutdown\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true
                };
                var p = Process.Start(psi);
                p.WaitForExit(800);
                _shutdownInfo = (p.ExitCode == 0) ? "开" : "关";
            }
            catch { _shutdownInfo = "关"; }
        }

        private void InitWindow()
        {
            Title = "CastFlow · 大屏投放控制台";
            Width = 550;
            Height = 845;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            ResizeMode = ResizeMode.CanMinimize;
            Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(13, 17, 23));

            var mainGrid = new Grid { Margin = new Thickness(22) };
            mainGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 0: 标题头
            mainGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 1: 核心状态卡片
            mainGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 2: 环境详细信息卡片
            mainGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); // 3: 操作按钮区
            mainGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); // 4: 底部操作提示与退出

            // 0. 标题头
            var header = new StackPanel { Margin = new Thickness(0, 0, 0, 16) };
            var titleRow = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal };
            
            var logoBorder = new Border
            {
                Width = 28, Height = 28,
                CornerRadius = new CornerRadius(6),
                ClipToBounds = true,
                Margin = new Thickness(0, 0, 10, 0),
                Background = System.Windows.Media.Brushes.Transparent,
                VerticalAlignment = VerticalAlignment.Center
            };
            var logoImg = new System.Windows.Controls.Image
            {
                Stretch = System.Windows.Media.Stretch.Uniform
            };
            try
            {
                string pLogo = System.IO.Path.Combine(_appRoot, "public", "logo.png");
                if (!File.Exists(pLogo)) pLogo = System.IO.Path.Combine(_appRoot, "app.ico");
                if (File.Exists(pLogo))
                {
                    var bi = new System.Windows.Media.Imaging.BitmapImage();
                    bi.BeginInit();
                    bi.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
                    bi.UriSource = new Uri(pLogo);
                    bi.EndInit();
                    bi.Freeze();
                    logoImg.Source = bi;
                }
            }
            catch { }
            logoBorder.Child = logoImg;
            titleRow.Children.Add(logoBorder);

            var titleTxt = new TextBlock
            {
                Text = "CastFlow · 大屏投放控制台",
                FontSize = 17,
                FontWeight = FontWeights.Bold,
                Foreground = System.Windows.Media.Brushes.White,
                VerticalAlignment = VerticalAlignment.Center
            };
            titleRow.Children.Add(titleTxt);
            header.Children.Add(titleRow);

            var line1 = new System.Windows.Shapes.Rectangle
            {
                Height = 2,
                Margin = new Thickness(0, 10, 0, 0),
                Fill = new LinearGradientBrush(
                    System.Windows.Media.Color.FromRgb(62, 130, 247),
                    System.Windows.Media.Color.FromRgb(30, 41, 59), 0)
            };
            header.Children.Add(line1);
            Grid.SetRow(header, 0);
            mainGrid.Children.Add(header);

            // 1. 核心状态卡片 (服务/浏览器/访问地址/默认网页)
            var card1 = CreateCard();
            card1.Margin = new Thickness(0, 0, 0, 12);
            var sp1 = new StackPanel();

            // 服务状态行
            var rowSrv = new Grid { Margin = new Thickness(0, 0, 0, 9) };
            rowSrv.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });
            rowSrv.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            rowSrv.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var lblSrv = new TextBlock { Text = "服务", FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(160, 175, 195)), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(lblSrv, 0);
            rowSrv.Children.Add(lblSrv);

            _tagService = CreateTag("[检测中]", System.Windows.Media.Color.FromRgb(80, 90, 105), System.Windows.Media.Brushes.White);
            _txtServiceTag = (TextBlock)_tagService.Child;
            Grid.SetColumn(_tagService, 1);
            rowSrv.Children.Add(_tagService);

            var srvMeta = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            _txtServicePid = new TextBlock { Text = "PID —", FontSize = 12, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(130, 145, 165)), Margin = new Thickness(0, 0, 14, 0) };
            _txtServicePort = new TextBlock { Text = "端口 " + _port, FontSize = 12, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(130, 145, 165)) };
            var btnEditPort = new System.Windows.Controls.Button
            {
                Content = "✎",
                FontSize = 11,
                ToolTip = "修改控制台端口",
                Margin = new Thickness(6, 0, 0, 0),
                Padding = new Thickness(4, 0, 4, 0),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 40, 56)),
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(94, 159, 232)),
                BorderThickness = new Thickness(0),
                Cursor = System.Windows.Input.Cursors.Hand
            };
            ApplyButtonCornerRadius(btnEditPort, 4);
            btnEditPort.Click += (s, e) => PromptChangePort();

            srvMeta.Children.Add(_txtServicePid);
            srvMeta.Children.Add(_txtServicePort);
            srvMeta.Children.Add(btnEditPort);
            Grid.SetColumn(srvMeta, 2);
            rowSrv.Children.Add(srvMeta);
            sp1.Children.Add(rowSrv);

            // 浏览器状态行
            var rowBrowser = new Grid { Margin = new Thickness(0, 0, 0, 14) };
            rowBrowser.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });
            rowBrowser.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            rowBrowser.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var lblBrowser = new TextBlock { Text = "浏览器", FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(160, 175, 195)), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(lblBrowser, 0);
            rowBrowser.Children.Add(lblBrowser);

            _tagChrome = CreateTag("[检测中]", System.Windows.Media.Color.FromRgb(80, 90, 105), System.Windows.Media.Brushes.White);
            _txtChromeTag = (TextBlock)_tagChrome.Child;
            Grid.SetColumn(_tagChrome, 1);
            rowBrowser.Children.Add(_tagChrome);

            var browserMeta = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, Margin = new Thickness(14, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            _txtChromeTabs = new TextBlock { Text = "0 个标签页", FontSize = 12, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(130, 145, 165)), VerticalAlignment = VerticalAlignment.Center };
            browserMeta.Children.Add(_txtChromeTabs);

            _btnDownloadChrome = new System.Windows.Controls.Button
            {
                Content = "下载 Chrome",
                FontSize = 11,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(94, 159, 232)),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 42, 60)),
                BorderThickness = new Thickness(0),
                Padding = new Thickness(7, 2, 7, 2),
                Margin = new Thickness(10, 0, 0, 0),
                Cursor = System.Windows.Input.Cursors.Hand,
                Visibility = Visibility.Collapsed
            };
            ApplyButtonCornerRadius(_btnDownloadChrome, 4);
            _btnDownloadChrome.Click += (s, e) => OpenChromeDownloadPage();
            browserMeta.Children.Add(_btnDownloadChrome);

            Grid.SetColumn(browserMeta, 2);
            rowBrowser.Children.Add(browserMeta);
            sp1.Children.Add(rowBrowser);

            // 访问地址行
            var rowUrl = new Grid { Margin = new Thickness(0, 2, 0, 10) };
            rowUrl.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });
            rowUrl.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            rowUrl.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var lblUrl = new TextBlock { Text = "访问地址", FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(160, 175, 195)), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(lblUrl, 0);
            rowUrl.Children.Add(lblUrl);

            _txtAccessUrl = new TextBlock
            {
                Text = "http://127.0.0.1:" + _port,
                FontSize = 13,
                FontWeight = FontWeights.Medium,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(94, 159, 232)),
                TextDecorations = TextDecorations.Underline,
                Cursor = System.Windows.Input.Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center
            };
            _txtAccessUrl.MouseDown += (s, e) => OpenWebConsole();
            Grid.SetColumn(_txtAccessUrl, 1);
            rowUrl.Children.Add(_txtAccessUrl);

            var btnCopy = new System.Windows.Controls.Button
            {
                Content = "复制",
                FontSize = 11,
                Padding = new Thickness(8, 2, 8, 2),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 34, 48)),
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 195, 215)),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 60, 80)),
                Cursor = System.Windows.Input.Cursors.Hand
            };
            ApplyButtonCornerRadius(btnCopy, 6);
            btnCopy.Click += (s, e) =>
            {
                try
                {
                    System.Windows.Clipboard.SetText(_txtAccessUrl.Text);
                    SetHint("已复制控制台地址到剪贴板");
                }
                catch { }
            };
            Grid.SetColumn(btnCopy, 2);
            rowUrl.Children.Add(btnCopy);
            sp1.Children.Add(rowUrl);

            // 默认启动页配置行
            var rowStartUrl = new Grid { Margin = new Thickness(0, 0, 0, 2) };
            rowStartUrl.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });
            rowStartUrl.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            rowStartUrl.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var lblStartUrl = new TextBlock
            {
                Text = "默认网页",
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(160, 175, 195)),
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(lblStartUrl, 0);
            rowStartUrl.Children.Add(lblStartUrl);

            _txtStartUrl = CreateRoundedTextBox(_startUrl);
            _txtStartUrl.ToolTip = "服务启动或开机自启时大屏默认展示的网页（修改后按回车或点保存）";
            _txtStartUrl.KeyDown += (s, e) =>
            {
                if (e.Key == System.Windows.Input.Key.Enter)
                {
                    SaveStartUrlAction();
                }
            };
            Grid.SetColumn(_txtStartUrl, 1);
            rowStartUrl.Children.Add(_txtStartUrl);

            _btnSaveStartUrl = new System.Windows.Controls.Button
            {
                Content = "保存",
                FontSize = 11,
                FontWeight = FontWeights.Bold,
                Width = 52,
                Height = 28,
                Margin = new Thickness(8, 0, 0, 0),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 134, 54)),
                Foreground = System.Windows.Media.Brushes.White,
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(46, 160, 67)),
                Cursor = System.Windows.Input.Cursors.Hand
            };
            ApplyButtonCornerRadius(_btnSaveStartUrl, 6);
            _btnSaveStartUrl.Click += (s, e) => SaveStartUrlAction();
            Grid.SetColumn(_btnSaveStartUrl, 2);
            rowStartUrl.Children.Add(_btnSaveStartUrl);
            sp1.Children.Add(rowStartUrl);

            card1.Child = sp1;
            Grid.SetRow(card1, 1);
            mainGrid.Children.Add(card1);

            // 2. 环境与硬件详细信息卡片
            var card2 = CreateCard();
            card2.Margin = new Thickness(0, 0, 0, 14);
            var sp2 = new StackPanel();

            // 运行方式
            _txtRunMode = AddDetailRow(sp2, "运行方式", _isPackaged ? "打包版（内置 Node 运行时）" : "源码模式（需系统装有 Node）");

            // Node
            _txtNodeVer = AddDetailRow(sp2, "Node", _cachedNodeVer);
            _txtNodePath = AddSubPathRow(sp2, _cachedNodePath);

            // Chrome
            _txtChromeVer = AddDetailRow(sp2, "Chrome", _cachedChromeVer);
            _txtChromePath = AddSubPathRow(sp2, _cachedChromePath);

            // 程序目录
            _txtAppDir = AddDetailRow(sp2, "程序目录", _appRoot);

            // 内存
            _txtMemoryInfo = AddDetailRow(sp2, "内存", "页面 — / 阈值 400 MB · Chrome —");
            _pbMemory = new System.Windows.Controls.ProgressBar
            {
                Height = 4,
                Maximum = 400,
                Value = 0,
                Margin = new Thickness(80, 3, 0, 7),
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(62, 130, 247)),
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(26, 36, 50)),
                BorderThickness = new Thickness(0)
            };
            sp2.Children.Add(_pbMemory);

            // 系统内存
            _txtSysMemory = AddDetailRow(sp2, "系统内存", "-- / -- GB");

            // 看门狗
            _txtWatchdog = AddDetailRow(sp2, "看门狗", "已重载 0 次");

            card2.Child = sp2;
            Grid.SetRow(card2, 2);
            mainGrid.Children.Add(card2);

            // 3. 操作按钮区（2列网格，与 [1]~[6] 完全对齐）
            var btnGrid = new Grid { Margin = new Thickness(0, 0, 0, 12) };
            btnGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            btnGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(12) });
            btnGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            btnGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(50) });
            btnGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(10) });
            btnGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(50) });
            btnGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(10) });
            btnGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(50) });

            _btnStart = CreateActionButton("[1] 启动服务", System.Windows.Media.Color.FromRgb(46, 117, 222), System.Windows.Media.Brushes.White);
            _btnStart.Click += async (s, e) => await ActionStartAsync();
            Grid.SetRow(_btnStart, 0); Grid.SetColumn(_btnStart, 0);
            btnGrid.Children.Add(_btnStart);

            _btnStop = CreateActionButton("[2] 停止服务", System.Windows.Media.Color.FromRgb(26, 36, 50), new SolidColorBrush(System.Windows.Media.Color.FromRgb(235, 95, 95)));
            _btnStop.Click += async (s, e) => await ActionStopAsync();
            Grid.SetRow(_btnStop, 0); Grid.SetColumn(_btnStop, 2);
            btnGrid.Children.Add(_btnStop);

            _btnRestart = CreateActionButton("[3] 重启服务", System.Windows.Media.Color.FromRgb(22, 32, 45), System.Windows.Media.Brushes.White);
            _btnRestart.Click += async (s, e) => await ActionRestartAsync();
            Grid.SetRow(_btnRestart, 2); Grid.SetColumn(_btnRestart, 0);
            btnGrid.Children.Add(_btnRestart);

            _btnAutoStart = CreateActionButton("[4] 开机自启：" + (_autoStartOn ? "开" : "关"), System.Windows.Media.Color.FromRgb(22, 32, 45), System.Windows.Media.Brushes.White);
            _btnAutoStart.Click += (s, e) => ActionToggleAutoStart();
            Grid.SetRow(_btnAutoStart, 2); Grid.SetColumn(_btnAutoStart, 2);
            btnGrid.Children.Add(_btnAutoStart);

            _btnViewLog = CreateActionButton("[5] 查看日志", System.Windows.Media.Color.FromRgb(22, 32, 45), System.Windows.Media.Brushes.White);
            _btnViewLog.Click += (s, e) => OpenLogFile();
            Grid.SetRow(_btnViewLog, 4); Grid.SetColumn(_btnViewLog, 0);
            btnGrid.Children.Add(_btnViewLog);

            _btnTimedShutdown = CreateActionButton("[6] 定时关机：" + _shutdownInfo, System.Windows.Media.Color.FromRgb(22, 32, 45), System.Windows.Media.Brushes.White);
            _btnTimedShutdown.Click += (s, e) => ActionConfigShutdown();
            Grid.SetRow(_btnTimedShutdown, 4); Grid.SetColumn(_btnTimedShutdown, 2);
            btnGrid.Children.Add(_btnTimedShutdown);

            Grid.SetRow(btnGrid, 3);
            mainGrid.Children.Add(btnGrid);

            // 4. 底部状态与退出
            var footGrid = new Grid { Margin = new Thickness(0, 8, 0, 0) };
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var footLeft = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            _txtHint = new TextBlock
            {
                Text = "就绪 (关闭窗口将最小化到任务栏托盘持续守护)",
                FontSize = 11.5,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(110, 125, 145))
            };
            footLeft.Children.Add(_txtHint);

            var gitRow = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 0) };
            var lblGit = new TextBlock
            {
                Text = "GitHub",
                FontSize = 11,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(78, 128, 192)),
                TextDecorations = TextDecorations.Underline,
                Cursor = System.Windows.Input.Cursors.Hand,
                ToolTip = "点击在浏览器中打开 GitHub 开源仓库 (https://github.com/caoyek/castflow)",
                VerticalAlignment = VerticalAlignment.Center
            };
            lblGit.MouseDown += (s, e) =>
            {
                try { Process.Start(new ProcessStartInfo("https://github.com/caoyek/castflow") { UseShellExecute = true }); }
                catch { }
            };
            gitRow.Children.Add(lblGit);

            var lblSep = new TextBlock
            {
                Text = " · ",
                FontSize = 11,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(80, 95, 115)),
                VerticalAlignment = VerticalAlignment.Center
            };
            gitRow.Children.Add(lblSep);

            _txtVersion = new TextBlock
            {
                Text = CURRENT_VERSION,
                FontSize = 11,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(130, 145, 165)),
                VerticalAlignment = VerticalAlignment.Center
            };
            gitRow.Children.Add(_txtVersion);

            // 更新下载按钮（默认折叠，检测到新版本时展示在版本号右侧）
            _btnUpdate = new Border
            {
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(24, 72, 138)),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(55, 125, 220)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(4),
                Padding = new Thickness(6, 1, 6, 1),
                Margin = new Thickness(8, 0, 0, 0),
                Cursor = System.Windows.Input.Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center,
                Visibility = Visibility.Collapsed,
                ToolTip = "点击自动下载新版本安装包并启动升级"
            };
            _txtUpdateIcon = new TextBlock
            {
                Text = "⬇ 新版可用",
                FontSize = 10.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = System.Windows.Media.Brushes.White
            };
            _btnUpdate.Child = _txtUpdateIcon;
            _btnUpdate.MouseDown += (s, e) => OnUpdateClicked();
            gitRow.Children.Add(_btnUpdate);

            footLeft.Children.Add(gitRow);

            Grid.SetColumn(footLeft, 0);
            footGrid.Children.Add(footLeft);

            var btnQuit = CreateActionButton("退  出", System.Windows.Media.Color.FromRgb(218, 54, 51), System.Windows.Media.Brushes.White);
            btnQuit.Width = 110;
            btnQuit.Height = 40;
            btnQuit.FontSize = 14;
            btnQuit.FontWeight = FontWeights.Bold;
            btnQuit.Margin = new Thickness(14, 0, 0, 0);
            btnQuit.Click += async (s, e) =>
            {
                if (System.Windows.MessageBox.Show("确定要退出 CastFlow 大屏控制台吗？\n(退出后将彻底停止后台服务与大屏浏览器)", "退出确认", MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes)
                {
                    btnQuit.IsEnabled = false;
                    await SafeExitAsync();
                }
            };
            Grid.SetColumn(btnQuit, 1);
            footGrid.Children.Add(btnQuit);

            Grid.SetRow(footGrid, 4);
            mainGrid.Children.Add(footGrid);

            Content = mainGrid;

            // 拦截右上角叉叉 -> 最小化到托盘
            Closing += (s, e) =>
            {
                e.Cancel = true;
                Hide();
                _trayIcon.ShowBalloonTip(1500, "CastFlow 已最小化", "大屏控制服务仍在后台持续守护运行中。", ToolTipIcon.Info);
            };
        }

        private TextBlock AddDetailRow(StackPanel parent, string title, string val)
        {
            var row = new Grid { Margin = new Thickness(0, 0, 0, 6) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var lbl = new TextBlock { Text = title, FontSize = 12, Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(140, 155, 175)), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(lbl, 0);
            row.Children.Add(lbl);

            var txt = new TextBlock { Text = val, FontSize = 12, Foreground = System.Windows.Media.Brushes.White, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(txt, 1);
            row.Children.Add(txt);

            parent.Children.Add(row);
            return txt;
        }

        private TextBlock AddSubPathRow(StackPanel parent, string path)
        {
            var row = new Grid { Margin = new Thickness(80, -3, 0, 6) };
            var txt = new TextBlock
            {
                Text = path,
                FontSize = 10.5,
                Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(95, 110, 130)),
                TextTrimming = TextTrimming.CharacterEllipsis
            };
            row.Children.Add(txt);
            parent.Children.Add(row);
            return txt;
        }

        private Border CreateTag(string text, System.Windows.Media.Color bg, System.Windows.Media.Brush fg)
        {
            var border = new Border
            {
                Background = new SolidColorBrush(bg),
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(8, 2, 8, 2),
                VerticalAlignment = VerticalAlignment.Center
            };
            border.Child = new TextBlock
            {
                Text = text,
                FontSize = 11.5,
                FontWeight = FontWeights.Bold,
                Foreground = fg
            };
            return border;
        }

        private Border CreateCard()
        {
            return new Border
            {
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(22, 27, 34)),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(48, 54, 61)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(16, 13, 16, 13)
            };
        }

        private System.Windows.Controls.Button CreateActionButton(string text, System.Windows.Media.Color bg, System.Windows.Media.Brush fg)
        {
            var btn = new System.Windows.Controls.Button
            {
                Content = text,
                Background = new SolidColorBrush(bg),
                Foreground = fg,
                FontSize = 13.5,
                FontWeight = FontWeights.Bold,
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(48, 54, 61)),
                BorderThickness = new Thickness(1),
                Cursor = System.Windows.Input.Cursors.Hand
            };

            var template = new ControlTemplate(typeof(System.Windows.Controls.Button));
            var borderFactory = new FrameworkElementFactory(typeof(Border));
            borderFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(8));
            borderFactory.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(BackgroundProperty));
            borderFactory.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(BorderBrushProperty));
            borderFactory.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(BorderThicknessProperty));
            borderFactory.SetValue(Border.PaddingProperty, new TemplateBindingExtension(PaddingProperty));

            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(HorizontalAlignmentProperty, System.Windows.HorizontalAlignment.Center);
            presenter.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center);
            borderFactory.AppendChild(presenter);

            template.VisualTree = borderFactory;
            btn.Template = template;
            return btn;
        }

        private void ApplyAppIcon()
        {
            try
            {
                string icoPath = System.IO.Path.Combine(_appRoot, "app.ico");
                if (!File.Exists(icoPath))
                {
                    icoPath = System.IO.Path.Combine(_appRoot, "manager", "app.ico");
                }

                System.Drawing.Icon appIcon = null;
                if (File.Exists(icoPath))
                {
                    appIcon = new System.Drawing.Icon(icoPath);
                    this.Icon = System.Windows.Media.Imaging.BitmapFrame.Create(new Uri(icoPath));
                }
                else
                {
                    string curExe = Process.GetCurrentProcess().MainModule.FileName;
                    appIcon = System.Drawing.Icon.ExtractAssociatedIcon(curExe);
                    if (appIcon != null)
                    {
                        using (var ms = new MemoryStream())
                        {
                            appIcon.ToBitmap().Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                            ms.Seek(0, SeekOrigin.Begin);
                            this.Icon = System.Windows.Media.Imaging.BitmapFrame.Create(ms);
                        }
                    }
                }

                if (appIcon != null && _trayIcon != null)
                {
                    _trayIcon.Icon = appIcon;
                }
            }
            catch { }
        }

        private void InitTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开控制台面板", null, (s, e) => ShowWindow());
            menu.Items.Add("打开 Web 控制台", null, (s, e) => OpenWebConsole());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("重启服务", null, async (s, e) => await ActionRestartAsync());
            menu.Items.Add("检查新版本...", null, async (s, e) => await CheckForUpdatesManuallyAsync());
            menu.Items.Add("访问 GitHub 仓库", null, (s, e) =>
            {
                try { Process.Start(new ProcessStartInfo("https://github.com/caoyek/castflow") { UseShellExecute = true }); }
                catch { }
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出 CastFlow", null, async (s, e) =>
            {
                await SafeExitAsync();
            });

            _trayIcon = new NotifyIcon
            {
                Text = "CastFlow · 大屏投放控制台",
                Icon = SystemIcons.Application,
                ContextMenuStrip = menu,
                Visible = true
            };

            _trayIcon.DoubleClick += (s, e) => ShowWindow();
        }

        private void ShowWindow()
        {
            Show();
            WindowState = WindowState.Normal;
            Activate();
        }

        // ================= 状态轮询 =================
        private async Task CheckStatusAsync()
        {
            if (_isChecking) return;
            _isChecking = true;

            string jsonStatus = null;
            string jsonLocal = null;

            try
            {
                using (var cts = new System.Threading.CancellationTokenSource(1500))
                {
                    var req1 = new HttpRequestMessage(HttpMethod.Get, "http://127.0.0.1:" + _port + "/api/status");
                    var res1 = await _http.SendAsync(req1, cts.Token);
                    if (res1.IsSuccessStatusCode)
                    {
                        jsonStatus = await res1.Content.ReadAsStringAsync();
                    }
                }
            }
            catch { }

            if (jsonStatus != null)
            {
                try
                {
                    using (var cts = new System.Threading.CancellationTokenSource(1500))
                    {
                        var req2 = new HttpRequestMessage(HttpMethod.Get, "http://127.0.0.1:" + _port + "/api/local");
                        var res2 = await _http.SendAsync(req2, cts.Token);
                        if (res2.IsSuccessStatusCode)
                        {
                            jsonLocal = await res2.Content.ReadAsStringAsync();
                        }
                    }
                }
                catch { }
            }

            _isChecking = false;

            try
            {
                Dispatcher.Invoke(new Action(() =>
                {
                    ApplyState(jsonStatus, jsonLocal);
                }));
            }
            catch { }
        }

        private void ApplyState(string st, string local)
        {
            if (st != null)
            {
                // 服务在线
                int pid = local != null ? ParseJsonInt(local, "pid", 0) : 0;
                _currentServerPid = pid;
                string baseIp = local != null ? ExtractJsonValue(local, "base") : null;
                if (string.IsNullOrEmpty(baseIp)) baseIp = "http://" + GetBestLocalIpv4() + ":" + _port;

                _tagService.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 134, 54));
                _txtServiceTag.Text = "[运行中]";
                _txtServicePid.Text = pid > 0 ? "PID " + pid : "PID 运行中";
                _txtServicePort.Text = "端口 " + _port;
                _txtAccessUrl.Text = baseIp;

                bool online = st.Contains("\"online\":true");
                int pageCount = ParseJsonInt(st, "pageCount", 1);
                int heapMb = ParseJsonInt(st, "heapMb", 0);
                int chromeMb = ParseJsonInt(st, "chromeMb", 0);
                int memLimit = ParseJsonInt(st, "memoryLimitMb", 400);
                int reloadCount = ParseJsonInt(st, "reloadCount", 0);
                int sysUsed = ParseJsonInt(st, "sysUsedMb", 0);
                int sysTotal = ParseJsonInt(st, "sysTotalMb", 0);

                UpdateBrowserUiState(online, pageCount);

                string heapStr = (heapMb > 0) ? heapMb + " MB" : "—";
                string chromeStr = (chromeMb > 0) ? chromeMb + " MB" : "—";
                _txtMemoryInfo.Text = "页面 " + heapStr + " / 阈值 " + memLimit + " MB · Chrome " + chromeStr;

                _pbMemory.Maximum = memLimit > 0 ? memLimit : 400;
                _pbMemory.Value = heapMb;

                if (sysTotal > 0)
                {
                    double usedGb = Math.Round(sysUsed / 1024.0, 1);
                    double totalGb = Math.Round(sysTotal / 1024.0, 1);
                    _txtSysMemory.Text = usedGb + " / " + totalGb + " GB";
                }

                _txtWatchdog.Text = "已重载 " + reloadCount + " 次";

                _btnStart.IsEnabled = !online;
                _btnStop.IsEnabled = true;
                _btnRestart.IsEnabled = true;
            }
            else
            {
                // 服务停止
                _tagService.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(218, 54, 51));
                _txtServiceTag.Text = "[已停止]";
                _txtServicePid.Text = "PID —";
                _txtServicePort.Text = "端口 " + _port;
                _txtAccessUrl.Text = "http://" + GetBestLocalIpv4() + ":" + _port;

                UpdateBrowserUiState(false, 0);

                _txtMemoryInfo.Text = "页面 — / 阈值 400 MB · Chrome —";
                _pbMemory.Value = 0;
                _txtSysMemory.Text = "-- / -- GB";
                _txtWatchdog.Text = "已重载 0 次";

                _btnStart.IsEnabled = true;
                _btnStop.IsEnabled = false;
                _btnRestart.IsEnabled = false;
            }

            _btnAutoStart.Content = "[4] 开机自启：" + (_autoStartOn ? "开" : "关");
            _btnTimedShutdown.Content = "[6] 定时关机：" + _shutdownInfo;
        }

        private string GetBestLocalIpv4()
        {
            try
            {
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                    string name = ni.Name.ToLower();
                    if (name.Contains("virtual") || name.Contains("vmware") || name.Contains("hyper-v") || name.Contains("wsl")) continue;

                    foreach (var ip in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ip.Address.AddressFamily == AddressFamily.InterNetwork && !ip.Address.ToString().StartsWith("169.254."))
                        {
                            return ip.Address.ToString();
                        }
                    }
                }
            }
            catch { }
            return "127.0.0.1";
        }

        // ================= 动作执行 =================
        private async Task ActionStartAsync()
        {
            if (_browserType == "none")
            {
                var res = System.Windows.MessageBox.Show(
                    "系统中未检测到 Google Chrome 或 Edge 浏览器！\n\n" +
                    "CastFlow 大屏展示依赖 Chrome 渲染大屏并进行远程控制。\n\n" +
                    "是否立即前往 Google Chrome 官网下载并安装？",
                    "未检测到大屏浏览器",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning);
                if (res == MessageBoxResult.Yes)
                {
                    OpenChromeDownloadPage();
                }
                SetHint("请先安装 Google Chrome 后启动服务");
                return;
            }

            if (_browserType == "edge")
            {
                SetHint("正在使用系统内置 Microsoft Edge 启动大屏…");
            }
            else
            {
                SetHint("正在拉起服务与大屏…");
            }
            try
            {
                string exe = System.IO.Path.Combine(_appRoot, "CastFlow.exe");
                if (File.Exists(exe))
                {
                    Process.Start(new ProcessStartInfo(exe, "--autostart") { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
                }
                else
                {
                    string mainJs = System.IO.Path.Combine(_appRoot, "main.js");
                    Process.Start(new ProcessStartInfo("node", "\"" + mainJs + "\" --autostart") { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
                }

                await Task.Delay(1500);
                await CheckStatusAsync();
                SetHint("启动指令已下发");
            }
            catch (Exception ex)
            {
                SetHint("启动失败: " + ex.Message);
            }
        }

        private async Task ActionStopAsync()
        {
            SetHint("正在停止后台服务…");
            try
            {
                // 1. 通知关闭 Chrome
                try
                {
                    using (var cts = new System.Threading.CancellationTokenSource(2000))
                    {
                        var req = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:" + _port + "/api/chrome/stop")
                        {
                            Content = new StringContent("{}", Encoding.UTF8, "application/json")
                        };
                        await _http.SendAsync(req, cts.Token);
                    }
                }
                catch { }

                // 2. 如果已获知服务 PID (node.exe 或 CastFlow.exe)，精准终止进程树
                if (_currentServerPid > 0)
                {
                    try
                    {
                        var psi = new ProcessStartInfo("taskkill", "/F /T /PID " + _currentServerPid)
                        {
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        var p = Process.Start(psi);
                        if (p != null) p.WaitForExit(1500);
                    }
                    catch { }
                }

                // 3. 兜底保障：按端口查杀占用该端口的进程树，避免残留
                KillProcessOnPort(_port);

                // 4. 清理名为 CastFlow 的打包进程
                foreach (var p in Process.GetProcessesByName("CastFlow"))
                {
                    try { p.Kill(); } catch { }
                }

                // 5. 确保带调试端口的 Chrome 彻底退出，避免残留孤儿浏览器
                KillChromeDebuggerProcess();

                _currentServerPid = 0;
                ApplyState(null, null); // 立即更新 UI 为停止状态
                await Task.Delay(1000);
                await CheckStatusAsync();
                SetHint("后台服务已成功停止");
            }
            catch (Exception ex)
            {
                SetHint("停止服务异常: " + ex.Message);
            }
        }

        private void KillProcessOnPort(int port)
        {
            try
            {
                string cmd = "$c = Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue; if ($c) { foreach ($target in $c.OwningProcess) { taskkill /F /T /PID $target } }";
                var psi = new ProcessStartInfo("powershell", "-NoProfile -Command \"" + cmd + "\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                var proc = Process.Start(psi);
                if (proc != null) proc.WaitForExit(2500);
            }
            catch { }
        }

        private async Task ActionRestartAsync()
        {
            SetHint("正在重启服务与大屏…");
            await ActionStopAsync();
            await Task.Delay(1200);
            await ActionStartAsync();
        }

        private void ActionToggleAutoStart()
        {
            try
            {
                string exe = System.IO.Path.Combine(_appRoot, "CastFlow.exe");
                string actionTarget = File.Exists(exe) ? exe : "node.exe";
                string actionArg = File.Exists(exe) ? "--autostart" : "\"" + System.IO.Path.Combine(_appRoot, "main.js") + "\" --autostart";

                if (!_autoStartOn)
                {
                    // 开启
                    string cmd = "/create /tn \"CastFlow\" /tr \"\\\"" + actionTarget + "\\\" " + actionArg + "\" /sc onlogon /rl highest /f";
                    var p = Process.Start(new ProcessStartInfo("schtasks", cmd) { UseShellExecute = true, Verb = "runas" });
                    p.WaitForExit();
                }
                else
                {
                    // 关闭
                    var p = Process.Start(new ProcessStartInfo("schtasks", "/delete /tn \"CastFlow\" /f") { UseShellExecute = true, Verb = "runas" });
                    p.WaitForExit();
                }

                CheckScheduledTasks();
                _btnAutoStart.Content = "[4] 开机自启：" + (_autoStartOn ? "开" : "关");
                SetHint("已更新开机自启配置为：" + (_autoStartOn ? "开" : "关"));
            }
            catch (Exception ex)
            {
                SetHint("设置自启失败: " + ex.Message);
            }
        }

        private void ActionConfigShutdown()
        {
            var dlg = new Window
            {
                Title = "定时关机配置",
                Width = 320, Height = 185,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Owner = this,
                ResizeMode = ResizeMode.NoResize,
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(22, 27, 34))
            };

            var sp = new StackPanel { Margin = new Thickness(16) };
            var lbl = new TextBlock { Text = "设置每天定时关机时间 (HH:mm 如 22:30)：", Foreground = System.Windows.Media.Brushes.White, FontSize = 12, Margin = new Thickness(0, 0, 0, 8) };
            var txt = new System.Windows.Controls.TextBox { Text = "22:30", Height = 28, FontSize = 13, Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(13, 17, 23)), Foreground = System.Windows.Media.Brushes.White, BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(48, 54, 61)), Padding = new Thickness(4) };

            var btnRow = new Grid { Margin = new Thickness(0, 14, 0, 0) };
            btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(10) });
            btnRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

            var btnSet = new System.Windows.Controls.Button { Content = "设置开启", Height = 32, Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(46, 117, 222)), Foreground = System.Windows.Media.Brushes.White };
            var btnDel = new System.Windows.Controls.Button { Content = "关闭定时关机", Height = 32, Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(33, 38, 45)), Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(235, 95, 95)) };

            btnSet.Click += (s, e) =>
            {
                string t = txt.Text.Trim();
                if (System.Text.RegularExpressions.Regex.IsMatch(t, @"^([01]?[0-9]|2[0-3]):[0-5][0-9]$"))
                {
                    try
                    {
                        string cmd = "/create /tn \"CastFlowShutdown\" /tr \"shutdown /s /t 60\" /sc daily /st " + t + " /rl highest /f";
                        Process.Start(new ProcessStartInfo("schtasks", cmd) { UseShellExecute = true, Verb = "runas" }).WaitForExit();
                        CheckScheduledTasks();
                        _shutdownInfo = t;
                        _btnTimedShutdown.Content = "[6] 定时关机：" + _shutdownInfo;
                        SetHint("定时关机已设置为每天 " + t);
                        dlg.Close();
                    }
                    catch (Exception ex2) { System.Windows.MessageBox.Show("设置失败: " + ex2.Message); }
                }
                else
                {
                    System.Windows.MessageBox.Show("时间格式必须为 HH:mm 如 22:30", "提示");
                }
            };

            btnDel.Click += (s, e) =>
            {
                try
                {
                    Process.Start(new ProcessStartInfo("schtasks", "/delete /tn \"CastFlowShutdown\" /f") { UseShellExecute = true, Verb = "runas" }).WaitForExit();
                    CheckScheduledTasks();
                    _shutdownInfo = "关";
                    _btnTimedShutdown.Content = "[6] 定时关机：关";
                    SetHint("定时关机已取消");
                    dlg.Close();
                }
                catch (Exception ex2) { System.Windows.MessageBox.Show("取消失败: " + ex2.Message); }
            };

            Grid.SetColumn(btnSet, 0); btnRow.Children.Add(btnSet);
            Grid.SetColumn(btnDel, 2); btnRow.Children.Add(btnDel);

            sp.Children.Add(lbl);
            sp.Children.Add(txt);
            sp.Children.Add(btnRow);
            dlg.Content = sp;
            dlg.ShowDialog();
        }

        private void PromptChangePort()
        {
            var dlg = new Window
            {
                Title = "修改服务端口",
                Width = 320, Height = 180,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Owner = this,
                ResizeMode = ResizeMode.NoResize,
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(22, 27, 34))
            };

            var sp = new StackPanel { Margin = new Thickness(16) };
            var lbl = new TextBlock { Text = "设置控制台端口 (默认 18089):", Foreground = System.Windows.Media.Brushes.White, FontSize = 12, Margin = new Thickness(0, 0, 0, 8) };
            var txt = new System.Windows.Controls.TextBox { Text = _port.ToString(), Height = 28, FontSize = 13, Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(13, 17, 23)), Foreground = System.Windows.Media.Brushes.White, BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(48, 54, 61)), Padding = new Thickness(4) };
            var btn = new System.Windows.Controls.Button { Content = "确定并保存", Height = 32, Margin = new Thickness(0, 12, 0, 0), Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(46, 117, 222)), Foreground = System.Windows.Media.Brushes.White };

            btn.Click += (s, e) =>
            {
                int newPort;
                if (int.TryParse(txt.Text.Trim(), out newPort) && newPort >= 1024 && newPort <= 65535)
                {
                    SavePortToConfig(newPort);
                    _port = newPort;
                    _txtServicePort.Text = "端口 " + _port;
                    _txtAccessUrl.Text = "http://" + GetBestLocalIpv4() + ":" + _port;
                    SetHint("端口已保存为 " + _port + "，请重启服务生效");
                    dlg.Close();
                }
                else
                {
                    System.Windows.MessageBox.Show("请输入合法的端口范围 (1024 ~ 65535)", "提示");
                }
            };

            sp.Children.Add(lbl);
            sp.Children.Add(txt);
            sp.Children.Add(btn);
            dlg.Content = sp;
            dlg.ShowDialog();
        }

        private void SavePortToConfig(int newPort)
        {
            try
            {
                string cfgPath = System.IO.Path.Combine(_appRoot, "config.json");
                if (File.Exists(cfgPath))
                {
                    string content = File.ReadAllText(cfgPath);
                    content = System.Text.RegularExpressions.Regex.Replace(content, "\"port\"\\s*:\\s*\\d+", "\"port\": " + newPort);
                    File.WriteAllText(cfgPath, content);
                }
            }
            catch (Exception ex)
            {
                System.Windows.MessageBox.Show("保存配置失败: " + ex.Message, "错误");
            }
        }

        private void SaveStartUrlAction()
        {
            if (_txtStartUrl == null) return;
            string val = _txtStartUrl.Text.Trim();
            if (string.IsNullOrEmpty(val))
            {
                val = "about:blank";
                _txtStartUrl.Text = val;
            }

            if (SaveStartUrlToConfig(val))
            {
                _startUrl = val;
                SetHint("默认启动页已更新为: " + val);

                if (_btnSaveStartUrl != null)
                {
                    _btnSaveStartUrl.Content = "✓ 已存";
                    var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.8) };
                    timer.Tick += (s, e) =>
                    {
                        _btnSaveStartUrl.Content = "保存";
                        timer.Stop();
                    };
                    timer.Start();
                }
            }
        }

        private bool SaveStartUrlToConfig(string newUrl)
        {
            try
            {
                string cfgPath = System.IO.Path.Combine(_appRoot, "config.json");
                if (File.Exists(cfgPath))
                {
                    string content = File.ReadAllText(cfgPath);
                    if (System.Text.RegularExpressions.Regex.IsMatch(content, "\"startUrl\"\\s*:\\s*\"[^\"]*\""))
                    {
                        content = System.Text.RegularExpressions.Regex.Replace(
                            content,
                            "\"startUrl\"\\s*:\\s*\"[^\"]*\"",
                            "\"startUrl\": \"" + EscapeJson(newUrl) + "\""
                        );
                    }
                    else
                    {
                        int lastBrace = content.LastIndexOf('}');
                        if (lastBrace > 0)
                        {
                            string insert = ",\r\n  \"startUrl\": \"" + EscapeJson(newUrl) + "\"\r\n";
                            content = content.Insert(lastBrace, insert);
                        }
                    }
                    File.WriteAllText(cfgPath, content, Encoding.UTF8);
                    return true;
                }
            }
            catch (Exception ex)
            {
                System.Windows.MessageBox.Show("保存默认页配置失败: " + ex.Message, "错误");
            }
            return false;
        }

        private string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private System.Windows.Controls.TextBox CreateRoundedTextBox(string text)
        {
            var tb = new System.Windows.Controls.TextBox
            {
                Text = text,
                Height = 28,
                FontSize = 12,
                Foreground = System.Windows.Media.Brushes.White,
                Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(13, 17, 23)),
                BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(48, 54, 61)),
                BorderThickness = new Thickness(1),
                VerticalContentAlignment = VerticalAlignment.Center,
                Padding = new Thickness(8, 0, 8, 0),
                CaretBrush = System.Windows.Media.Brushes.White
            };

            var template = new ControlTemplate(typeof(System.Windows.Controls.TextBox));
            var borderFactory = new FrameworkElementFactory(typeof(Border));
            borderFactory.Name = "PART_Border";
            borderFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
            borderFactory.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(BackgroundProperty));
            borderFactory.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(BorderBrushProperty));
            borderFactory.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(BorderThicknessProperty));

            var scrollFactory = new FrameworkElementFactory(typeof(ScrollViewer));
            scrollFactory.Name = "PART_ContentHost";
            scrollFactory.SetValue(ScrollViewer.MarginProperty, new Thickness(0));
            scrollFactory.SetValue(ScrollViewer.PaddingProperty, new TemplateBindingExtension(PaddingProperty));
            borderFactory.AppendChild(scrollFactory);

            template.VisualTree = borderFactory;
            tb.Template = template;
            return tb;
        }

        private void ApplyButtonCornerRadius(System.Windows.Controls.Button btn, double radius)
        {
            var template = new ControlTemplate(typeof(System.Windows.Controls.Button));
            var borderFactory = new FrameworkElementFactory(typeof(Border));
            borderFactory.SetValue(Border.CornerRadiusProperty, new CornerRadius(radius));
            borderFactory.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(BackgroundProperty));
            borderFactory.SetValue(Border.BorderBrushProperty, new TemplateBindingExtension(BorderBrushProperty));
            borderFactory.SetValue(Border.BorderThicknessProperty, new TemplateBindingExtension(BorderThicknessProperty));
            borderFactory.SetValue(Border.PaddingProperty, new TemplateBindingExtension(PaddingProperty));

            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(HorizontalAlignmentProperty, System.Windows.HorizontalAlignment.Center);
            presenter.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center);
            borderFactory.AppendChild(presenter);

            template.VisualTree = borderFactory;
            btn.Template = template;
        }

        private void OpenWebConsole()
        {
            try
            {
                Process.Start(new ProcessStartInfo(_txtAccessUrl.Text) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                SetHint("打开控制台失败: " + ex.Message);
            }
        }

        private void OpenLogFile()
        {
            string[] logCands = new[] { "castflow.log", "server.out.log", "autostart.log" };
            foreach (var cand in logCands)
            {
                string p = System.IO.Path.Combine(_appRoot, cand);
                if (File.Exists(p))
                {
                    Process.Start("notepad.exe", p);
                    return;
                }
            }
            SetHint("暂未发现日志文件");
        }

        private void SetHint(string msg)
        {
            _txtHint.Text = msg + " (" + DateTime.Now.ToString("HH:mm:ss") + ")";
        }

        private string ExtractJsonValue(string json, string key)
        {
            int idx = json.IndexOf("\"" + key + "\"");
            if (idx == -1) return null;
            int colon = json.IndexOf(':', idx + key.Length + 2);
            if (colon == -1) return null;
            int start = colon + 1;
            while (start < json.Length && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n'))
                start++;

            if (start < json.Length && json[start] == '"')
            {
                int end = json.IndexOf('"', start + 1);
                if (end > start) return json.Substring(start + 1, end - start - 1);
            }
            return null;
        }

        private int ParseJsonInt(string json, string key, int fallback)
        {
            int idx = json.IndexOf("\"" + key + "\"");
            if (idx == -1) return fallback;
            int colon = json.IndexOf(':', idx + key.Length + 2);
            if (colon == -1) return fallback;
            int start = colon + 1;
            while (start < json.Length && (json[start] == ' ' || json[start] == '\t' || json[start] == '\r' || json[start] == '\n'))
                start++;
            int end = start;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
            int val;
            if (end > start && int.TryParse(json.Substring(start, end - start), out val))
                return val;
            return fallback;
        }

        private void UpdateBrowserUiState(bool online, int pageCount)
        {
            if (online)
            {
                _tagChrome.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 134, 54));
                _txtChromeTag.Text = _browserType == "edge" ? "[Edge 已连接]" : "[已连接]";
                _txtChromeTabs.Text = pageCount + " 个标签页";
                if (_btnDownloadChrome != null) _btnDownloadChrome.Visibility = Visibility.Collapsed;
            }
            else
            {
                if (_browserType == "chrome")
                {
                    _tagChrome.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(110, 118, 129));
                    _txtChromeTag.Text = "[未运行]";
                    _txtChromeTabs.Text = "0 个标签页";
                    if (_btnDownloadChrome != null) _btnDownloadChrome.Visibility = Visibility.Collapsed;
                }
                else if (_browserType == "edge")
                {
                    _tagChrome.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(38, 128, 235));
                    _txtChromeTag.Text = "[Edge 备选就绪]";
                    _txtChromeTabs.Text = "将使用系统 Edge 渲染";
                    if (_btnDownloadChrome != null) _btnDownloadChrome.Visibility = Visibility.Visible;
                }
                else
                {
                    _tagChrome.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 105, 30));
                    _txtChromeTag.Text = "[未检测到 Chrome]";
                    _txtChromeTabs.Text = "未安装浏览器";
                    if (_btnDownloadChrome != null) _btnDownloadChrome.Visibility = Visibility.Visible;
                }
            }
        }

        private string FindChromeExecutable()
        {
            try
            {
                string r = (string)Microsoft.Win32.Registry.GetValue(
                    @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "", null);
                if (string.IsNullOrEmpty(r) || !File.Exists(r))
                {
                    r = (string)Microsoft.Win32.Registry.GetValue(
                        @"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "", null);
                }
                if (!string.IsNullOrEmpty(r) && File.Exists(r)) return r;

                string[] cands = new[]
                {
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
                };
                foreach (var c in cands) { if (File.Exists(c)) return c; }
            }
            catch { }
            return null;
        }

        private string FindEdgeExecutable()
        {
            try
            {
                string r = (string)Microsoft.Win32.Registry.GetValue(
                    @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", "", null);
                if (string.IsNullOrEmpty(r) || !File.Exists(r))
                {
                    r = (string)Microsoft.Win32.Registry.GetValue(
                        @"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe", "", null);
                }
                if (!string.IsNullOrEmpty(r) && File.Exists(r)) return r;

                string[] cands = new[]
                {
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                    System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe")
                };
                foreach (var c in cands) { if (File.Exists(c)) return c; }
            }
            catch { }
            return null;
        }

        private void OpenChromeDownloadPage()
        {
            try
            {
                Process.Start(new ProcessStartInfo("https://www.google.cn/chrome/") { UseShellExecute = true });
            }
            catch
            {
                try { Process.Start("https://www.google.cn/chrome/"); } catch { }
            }
        }

        private void KillChromeDebuggerProcess()
        {
            try
            {
                KillProcessOnPort(9222);
            }
            catch { }

            try
            {
                string cmd = "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -match 'remote-debugging' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId }";
                var psi = new ProcessStartInfo("powershell", "-NoProfile -Command \"" + cmd + "\"")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                var proc = Process.Start(psi);
                if (proc != null) proc.WaitForExit(2500);
            }
            catch { }
        }

        private async Task SafeExitAsync()
        {
            try
            {
                SetHint("正在停止后台服务与大屏，准备退出…");
                await ActionStopAsync();
            }
            catch { }

            try
            {
                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                    _trayIcon.Dispose();
                }
            }
            catch { }

            System.Windows.Application.Current.Shutdown();
        }

        // ================= 在线更新 =================
        private async Task<bool> CheckForUpdatesSilentlyAsync()
        {
            try
            {
                using (var client = new HttpClient())
                {
                    client.DefaultRequestHeaders.UserAgent.ParseAdd("CastFlowManager/" + CURRENT_VERSION);
                    client.Timeout = TimeSpan.FromSeconds(6);
                    string url = "https://api.github.com/repos/caoyek/castflow/releases/latest";
                    var resp = await client.GetAsync(url);
                    if (!resp.IsSuccessStatusCode) return false;

                    string json = await resp.Content.ReadAsStringAsync();
                    string tagName = ExtractJsonValue(json, "tag_name");
                    if (string.IsNullOrEmpty(tagName)) return false;

                    if (IsNewerVersion(tagName, CURRENT_VERSION))
                    {
                        _latestVersionTag = tagName;
                        string dl = ExtractSetupExeDownloadUrl(json);
                        _installerDownloadUrl = !string.IsNullOrEmpty(dl)
                            ? dl
                            : "https://github.com/caoyek/castflow/releases/download/" + tagName + "/CastFlow-Setup-" + tagName.TrimStart('v', 'V') + ".exe";

                        Dispatcher.Invoke(new Action(() =>
                        {
                            _txtUpdateIcon.Text = "⬇ 新版 " + tagName;
                            _btnUpdate.Visibility = Visibility.Visible;
                            SetHint("发现新版本 " + tagName + "，可点击左下角下载图标升级");
                        }));
                        return true;
                    }
                }
            }
            catch { }
            return false;
        }

        private async Task CheckForUpdatesManuallyAsync()
        {
            SetHint("正在检查是否有新版本…");
            bool hasUpdate = await CheckForUpdatesSilentlyAsync();
            if (!hasUpdate)
            {
                SetHint("当前已是最新版本 (" + CURRENT_VERSION + ")");
                System.Windows.MessageBox.Show(
                    "当前已经是最新版本 (" + CURRENT_VERSION + ")！\n\n暂无可用更新。",
                    "检查更新",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
            else
            {
                OnUpdateClicked();
            }
        }

        private bool IsNewerVersion(string latest, string current)
        {
            try
            {
                string v1 = (latest ?? "").Trim().TrimStart('v', 'V');
                string v2 = (current ?? "").Trim().TrimStart('v', 'V');
                var ver1 = new Version(v1);
                var ver2 = new Version(v2);
                return ver1 > ver2;
            }
            catch
            {
                return !string.Equals(latest, current, StringComparison.OrdinalIgnoreCase);
            }
        }

        private string ExtractSetupExeDownloadUrl(string json)
        {
            try
            {
                int exeIdx = json.IndexOf(".exe\"");
                if (exeIdx != -1)
                {
                    int urlKey = json.IndexOf("\"browser_download_url\":", exeIdx - 200 > 0 ? exeIdx - 200 : 0);
                    if (urlKey == -1) urlKey = json.IndexOf("\"browser_download_url\":", exeIdx);
                    if (urlKey != -1)
                    {
                        int q1 = json.IndexOf('"', urlKey + 23);
                        int q2 = json.IndexOf('"', q1 + 1);
                        if (q1 != -1 && q2 > q1)
                        {
                            return json.Substring(q1 + 1, q2 - q1 - 1);
                        }
                    }
                }
            }
            catch { }
            return null;
        }

        private async void OnUpdateClicked()
        {
            if (_isDownloadingUpdate) return;
            if (string.IsNullOrEmpty(_installerDownloadUrl) || string.IsNullOrEmpty(_latestVersionTag)) return;

            var confirm = System.Windows.MessageBox.Show(
                "检测到 CastFlow 最新版本 " + _latestVersionTag + "！\n\n" +
                "点击【是】将立即在后台自动下载安装程序并执行覆盖升级。\n" +
                "(升级时您的资料库、收藏页面、起始页和端口配置均会完好保留)\n\n" +
                "是否立即开始升级？",
                "在线更新",
                MessageBoxButton.YesNo,
                MessageBoxImage.Information);

            if (confirm != MessageBoxResult.Yes) return;

            _isDownloadingUpdate = true;

            try
            {
                _txtUpdateIcon.Text = "⬇ 准备中...";
                SetHint("正在下载最新安装包 " + _latestVersionTag + "…");

                string tempFile = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "CastFlow-Setup-" + _latestVersionTag + ".exe");
                if (File.Exists(tempFile))
                {
                    try { File.Delete(tempFile); } catch { }
                }

                using (var wc = new System.Net.WebClient())
                {
                    wc.Headers.Add("User-Agent", "CastFlowManager/" + CURRENT_VERSION);
                    wc.DownloadProgressChanged += (s, e) =>
                    {
                        Dispatcher.Invoke(new Action(() =>
                        {
                            _txtUpdateIcon.Text = "⬇ " + e.ProgressPercentage + "%";
                            SetHint("正在下载更新包: " + e.ProgressPercentage + "% (" + Math.Round(e.BytesReceived / 1048576.0, 1) + " MB)");
                        }));
                    };

                    await wc.DownloadFileTaskAsync(new Uri(_installerDownloadUrl), tempFile);
                }

                if (File.Exists(tempFile) && new FileInfo(tempFile).Length > 1024 * 1024)
                {
                    _txtUpdateIcon.Text = "✔ 启动安装向导";
                    SetHint("下载完成，正在启动安装程序…");

                    // 启动安装程序（管理员提权执行）
                    Process.Start(new ProcessStartInfo(tempFile) { UseShellExecute = true });

                    // 延迟 1 秒后优雅安全退出当前控制台，释放文件锁，允许安装向导执行文件覆盖
                    await Task.Delay(1000);
                    await SafeExitAsync();
                }
                else
                {
                    throw new Exception("下载文件校验失败或文件不完整");
                }
            }
            catch (Exception ex)
            {
                _isDownloadingUpdate = false;
                _txtUpdateIcon.Text = "⬇ 重试更新";
                SetHint("更新包下载失败: " + ex.Message);

                var res = System.Windows.MessageBox.Show(
                    "在线下载安装包失败：" + ex.Message + "\n\n" +
                    "可能由于网络连接 GitHub 超时导致。\n" +
                    "是否直接在系统浏览器中打开 Release 页面进行下载？",
                    "下载失败提示",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning);
                if (res == MessageBoxResult.Yes)
                {
                    try { Process.Start(new ProcessStartInfo("https://github.com/caoyek/castflow/releases/latest") { UseShellExecute = true }); } catch { }
                }
            }
        }
    }
}
