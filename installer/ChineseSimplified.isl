; Inno Setup 简体中文字符串
[LangOptions]
LanguageName=简体中文
LanguageCodePage=936
LanguageID=$0804

[Messages]
; 对话框标题
SetupAppTitle=安装
SetupWindowTitle=安装 - %1

; 欢迎页
WelcomeLabel1=欢迎使用 [name] 安装程序
WelcomeLabel2=此程序将安装 [name/ver] 到您的计算机上。%n%n建议您先关闭其他所有正在运行的应用程序，然后再继续安装。

; 安装模式选择页（所有用户 / 当前用户）
SelectSetupMode=选择安装模式
SelectSetupModeDescription=请选择将 %1 安装给所有用户，还是仅安装给当前用户。
AllUsers=为所有用户安装（推荐）
AllUsersDescription=为所有用户安装 %1。需要管理员权限，安装到 Program Files。
CurrentUser=仅为当前用户安装
CurrentUserDescription=仅为当前用户安装 %1，无需管理员权限，安装到个人目录，避免权限限制。

; 信息页
InfoBeforeLabel=安装说明
InfoBeforeClickLabel=请阅读以下重要信息，然后继续安装。
InfoAfterLabel=安装说明
InfoAfterClickLabel=请阅读以下重要信息，然后继续安装。

; 许可协议页
LicenseLabel=许可协议
LicenseLabel3=请阅读以下许可协议。使用翻页键阅读协议的其他部分。
LicenseAccepted=我接受协议中的条款(&A)
LicenseNotAccepted=我接受协议中的条款(&A)

; 选择目录页
SelectDirLabel=目标目录
SelectDirLabel3=安装程序将安装 [name] 到以下目录。
SelectDirBrowseLabel=要安装到不同目录，请单击"浏览"并选择其他目录。
SelectDirBrowse=浏览(&B)...

; 开始菜单页
SelectStartMenuFolderLabel=选择开始菜单文件夹
SelectStartMenuFolderLabel3=安装程序将创建程序快捷方式到以下开始菜单文件夹中。
SelectStartMenuFolderBrowseLabel=要使用不同的文件夹名称，请输入或单击"浏览"选择其他文件夹。
SelectStartMenuFolderBrowse=浏览(&B)...

; 附加任务页
SelectTasksLabel=选择附加任务
SelectTasksDesc=您想要安装程序执行哪些附加任务？
SelectTasksLabel2=请选择要执行的附加任务，然后单击"下一步"继续。

; 准备安装页
ReadyLabel1=准备安装
ReadyLabel2a=安装程序已准备好开始安装 [name] 到您的计算机。
ReadyLabel2b=单击"安装"继续安装，或单击"上一步"查看或更改设置。
ReadyMemoDir=目标目录：
ReadyMemoGroup=开始菜单文件夹：
ReadyMemoTasks=附加任务：

; 安装中页
InstallingLabel=正在安装
InstallingLabel2=请等待安装程序完成 [name] 的安装。

; 完成页
FinishedHeadingLabel=完成 [name] 安装向导
FinishedLabelNoIcons=安装程序已完成 [name] 的安装。
FinishedLabel=安装程序已完成 [name] 的安装。请单击"完成"退出安装程序。
ClickFinish=单击"完成"退出安装程序。

; 卸载
UninstallAppTitle=卸载
UninstallAppFullTitle=卸载 [name]

; 按钮
ButtonNext=下一步(&N)
ButtonInstall=安装(&I)
ButtonWizardInstall=安装(&I)
WizardSelectProgramGroup=选择开始菜单文件夹
WizardSelectTasks=选择附加任务
WizardSelectComponents=选择组件
WizardUninstalling=正在卸载
WizardUserInfo=用户信息
YesRadio=是(&Y)
ButtonYes=是(&Y)
ButtonNo=否(&N)
ButtonFinish=完成(&F)
ButtonCancel=取消
ButtonBrowse=浏览(&B)...
ButtonOK=确定
ButtonBack=上一步(&B)

; 消息
ExitSetupMessage=是否确实要退出安装程序？
SetupAborted=安装未完成。
SelectStartMenuFolderDesc=请选择开始菜单文件夹。

; 磁盘/文件
DiskSpaceMBWarning=%1 至少需要 %2 MB 的磁盘空间。
ErrorReadingTempDir=读取临时目录时出错。
ErrorCreateTempDir=创建临时目录时出错。
ErrorTooManyFilesInTempDir=临时目录中包含太多文件。
ErrorWritingTempFile=写入临时文件时出错。
ErrorReadingSourceDir=读取源目录时出错。
ErrorCopyingFile=复制文件时出错：%1
CannotCreateDest=无法创建目标文件：%1
SourceIsCorrupted=源文件已损坏：%1
ExistingDestDirIsNotDir=您指定的目标目录不是一个目录：%1
ExistingDestDirDoesntExist=您指定的目标目录不存在：%1
NoUninstall=卸载信息不存在。已从添加/删除程序列表中删除该程序条目。
ErrorRegisterServer=无法注册 DLL/OCX：%1
ErrorRegisterTypeLib=无法注册类型库：%1
ErrorCreateUninstall=创建卸载程序失败。
ErrorInternal=内部错误：%1
ErrorUnknown=未知错误。
ErrorWriteSections=错误：无法写入设置文件。

; 安装运行时
RunEntry=正在运行：%1
RunDeleteEntry=正在删除：%1
