!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
Var ModelRadioN
Var ModelRadioS
Var ModelRadioM
Var ModelRadioL
Var SelectedModel

Function ModelPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 38u "Choose the YOLO model to install. YOLO11n is recommended for most laptops; larger models need more memory and compute."
  Pop $0
  ${NSD_CreateRadioButton} 0 48u 100% 18u "YOLO11n — recommended, lightest model (5.6 MB)"
  Pop $ModelRadioN
  ${NSD_Check} $ModelRadioN
  ${NSD_CreateRadioButton} 0 72u 100% 18u "YOLO11s — small model (19.3 MB)"
  Pop $ModelRadioS
  ${NSD_CreateRadioButton} 0 96u 100% 18u "YOLO11m — medium model (40.7 MB)"
  Pop $ModelRadioM
  ${NSD_CreateRadioButton} 0 120u 100% 18u "YOLO11l — large model (51.4 MB; needs more memory and compute)"
  Pop $ModelRadioL
  nsDialogs::Show
FunctionEnd

Function ModelPageLeave
  ${NSD_GetState} $ModelRadioN $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $SelectedModel "yolo11n.pt"
  ${Else}
    ${NSD_GetState} $ModelRadioS $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $SelectedModel "yolo11s.pt"
    ${Else}
      ${NSD_GetState} $ModelRadioM $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $SelectedModel "yolo11m.pt"
      ${Else}
        StrCpy $SelectedModel "yolo11l.pt"
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom ModelPageCreate ModelPageLeave
!macroend

!macro customInit
  StrCpy $SelectedModel "yolo11n.pt"
!macroend

!macro customInstall
  FileOpen $0 "$INSTDIR\resources\model-selection.txt" w
  FileWrite $0 "$SelectedModel"
  FileClose $0
  ${If} $SelectedModel != "yolo11n.pt"
    Delete "$INSTDIR\resources\models\yolo11n.pt"
  ${EndIf}
  ${If} $SelectedModel != "yolo11s.pt"
    Delete "$INSTDIR\resources\models\yolo11s.pt"
  ${EndIf}
  ${If} $SelectedModel != "yolo11m.pt"
    Delete "$INSTDIR\resources\models\yolo11m.pt"
  ${EndIf}
  ${If} $SelectedModel != "yolo11l.pt"
    Delete "$INSTDIR\resources\models\yolo11l.pt"
  ${EndIf}
!macroend
!endif
