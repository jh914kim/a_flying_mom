# -*- coding: utf-8 -*-
"""
flying mom - 대한항공 룩앤필 모바일 사용자 매뉴얼 PDF 생성기 (초압축 2페이지 완결판)
- 룩앤필: 대한항공 (koreanair.com) 시그니처 스카이블루 (#0064DE), 딥 다크블루 (#051766), 에어리 스카이 (#EEF5FC)
- 규격: 스마트폰 9:16 모바일 최적화 규격 (125mm x 222mm)
- 페이지: 불필요한 공백을 전면 제거하여 딱 2페이지로 완결
- 폰트: 나눔스퀘어라운드 (NanumSquareRound)
- 실제 화면: 대한항공 테마 UI 캡처 4종 최적화 배치
- 결과물: 오직 단 하나의 파일 '엄마의_비행_사용설명서.pdf' 생성
"""

import os
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image as RLImage
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
import pymupdf

FONT_R = 'NanumRound'
FONT_B = 'NanumRoundB'
pdfmetrics.registerFont(TTFont(FONT_R, r'c:\work\aflyingmom\fonts\NanumSquareRoundR.ttf'))
pdfmetrics.registerFont(TTFont(FONT_B, r'c:\work\aflyingmom\fonts\NanumSquareRoundB.ttf'))

PAGE_WIDTH  = 125 * mm
PAGE_HEIGHT = 222 * mm
CONTENT_WIDTH = PAGE_WIDTH - 18 * mm  # 107 mm

KAL_DARK_BLUE = colors.HexColor('#051766')
KAL_SKY_BLUE  = colors.HexColor('#0064DE')
KAL_BG_SKY    = colors.HexColor('#EEF5FC')
KAL_BG_SUBTLE = colors.HexColor('#F4F8FD')
KAL_BORDER    = colors.HexColor('#C9D8EA')
KAL_TEXT_MAIN = colors.HexColor('#0C2340')
KAL_TEXT_SUB  = colors.HexColor('#556980')
WHITE         = colors.white

class CompactKALCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pages = []

    def showPage(self):
        self.pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self.pages)
        for page in self.pages:
            self.__dict__.update(page)
            self.draw_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_decorations(self, total_pages):
        self.saveState()
        page_num = self._pageNumber

        # 상단 대한항공 시그니처 투톤 바 (다크블루 + 스카이블루)
        self.setFillColor(KAL_DARK_BLUE)
        self.rect(0, PAGE_HEIGHT - 3.0*mm, PAGE_WIDTH, 2.0*mm, fill=1, stroke=0)
        self.setFillColor(KAL_SKY_BLUE)
        self.rect(0, PAGE_HEIGHT - 4.0*mm, PAGE_WIDTH, 1.0*mm, fill=1, stroke=0)

        # 상단 헤더 (2페이지)
        if page_num > 1:
            self.setFont(FONT_B, 7.5)
            self.setFillColor(KAL_DARK_BLUE)
            self.drawString(9*mm, PAGE_HEIGHT - 8.5*mm, "flying mom")
            
            self.setFont(FONT_R, 7)
            self.setFillColor(KAL_TEXT_SUB)
            self.drawString(26*mm, PAGE_HEIGHT - 8.5*mm, "• 사용 가이드")

            self.drawRightString(PAGE_WIDTH - 9*mm, PAGE_HEIGHT - 8.5*mm, f"{page_num} / {total_pages}")

            self.setStrokeColor(KAL_BORDER)
            self.setLineWidth(0.5)
            self.line(9*mm, PAGE_HEIGHT - 10.0*mm, PAGE_WIDTH - 9*mm, PAGE_HEIGHT - 10.0*mm)

        # 하단 푸터
        self.setStrokeColor(KAL_BORDER)
        self.setLineWidth(0.5)
        self.line(9*mm, 8.5*mm, PAGE_WIDTH - 9*mm, 8.5*mm)

        self.setFont(FONT_R, 7)
        self.setFillColor(KAL_TEXT_SUB)
        self.drawString(9*mm, 5.5*mm, "flying mom • 스마트폰 전용 가이드")
        self.drawRightString(PAGE_WIDTH - 9*mm, 5.5*mm, f"{page_num} / {total_pages}")

        self.restoreState()

def build_koreanair_manual(filename="엄마의_비행_사용설명서.pdf"):
    doc = SimpleDocTemplate(
        filename,
        pagesize=(PAGE_WIDTH, PAGE_HEIGHT),
        leftMargin=9*mm,
        rightMargin=9*mm,
        topMargin=11*mm,
        bottomMargin=10*mm
    )

    styles = {
        'Title': ParagraphStyle('Title', fontName=FONT_B, fontSize=17, leading=21, textColor=KAL_DARK_BLUE),
        'Sub': ParagraphStyle('Sub', fontName=FONT_R, fontSize=9.5, leading=13, textColor=KAL_SKY_BLUE),
        'SecTitle': ParagraphStyle('SecTitle', fontName=FONT_B, fontSize=11, leading=15, textColor=KAL_DARK_BLUE, spaceBefore=3, spaceAfter=2),
        'Body': ParagraphStyle('Body', fontName=FONT_R, fontSize=8.2, leading=11.8, textColor=KAL_TEXT_MAIN),
        'BodyBold': ParagraphStyle('BodyBold', fontName=FONT_B, fontSize=8.2, leading=11.8, textColor=KAL_TEXT_MAIN),
        'Tip': ParagraphStyle('Tip', fontName=FONT_R, fontSize=7.6, leading=10.8, textColor=KAL_TEXT_SUB)
    }

    story = []

    # ============================================================
    # PAGE 1: 표지 + 1단계 사진등록 + 2단계 확인 및 등록
    # ============================================================
    title_p = Paragraph("<b>flying mom</b> <font size=8.5 color='#0064DE'>| 비행 일정 & 위치 알리미 사용 가이드</font>", styles['Title'])
    intro_p = Paragraph(
        "별도 앱 설치 없이 링크만 누르면 바로 열려요! 비행 승무원의 일정과 실시간 상태를 온 가족이 스마트폰으로 확인하세요.",
        styles['Body']
    )
    t_header = Table([[title_p], [intro_p]], colWidths=[CONTENT_WIDTH])
    t_header.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), KAL_BG_SKY),
        ('BOX', (0, 0), (-1, -1), 0.8, KAL_BORDER),
        ('ROUNDEDCORNERS', [2*mm, 2*mm, 2*mm, 2*mm]),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_header)
    story.append(Spacer(1, 3))

    # 1단계: 사진으로 비행 일정 등록
    story.append(Paragraph("<b>1단계. 사진으로 비행 일정 등록 (엄마 폰)</b>", styles['SecTitle']))
    step1_text = Paragraph(
        "우측 상단 <b>[스케줄 관리]</b> &gt; 이번 달 연월 선택 &gt; 파란색 <b>[스케줄표 사진 인식]</b> 터치 &gt; 스케줄표 사진을 선택하면 편명과 비행시간이 10초 만에 자동으로 쏙 채워집니다.",
        styles['Body']
    )
    story.append(step1_text)
    story.append(Spacer(1, 2))

    # shot 1: 488 x 312
    img1 = RLImage(r'c:\work\aflyingmom\shot_kal_step1.png', width=CONTENT_WIDTH, height=52.0*mm)
    story.append(img1)
    story.append(Spacer(1, 4))

    # 2단계: 비행 목록 확인 & 등록 완료
    story.append(Paragraph("<b>2단계. 비행 목록 확인 & 최종 등록</b>", styles['SecTitle']))
    step2_text = Paragraph(
        "자동 추출된 편명·공항·비행시간을 확인하고, 맨 아래 <b>확인 체크박스</b>를 터치한 뒤 <b>[등록하기]</b>를 누르면 등록 완료!",
        styles['Body']
    )
    story.append(step2_text)
    story.append(Spacer(1, 2))

    # shot 2: 488 x 440 -> 55mm, shot 3: 488 x 190 -> 24mm
    img2 = RLImage(r'c:\work\aflyingmom\shot_kal_step2.png', width=CONTENT_WIDTH, height=55.0*mm)
    story.append(img2)
    story.append(Spacer(1, 2))
    img3 = RLImage(r'c:\work\aflyingmom\shot_kal_step3.png', width=CONTENT_WIDTH, height=24.0*mm)
    story.append(img3)

    story.append(PageBreak())

    # ============================================================
    # PAGE 2: 3단계 가족 공유 + 실시간 상태 안내 & 주요 기능
    # ============================================================
    story.append(Paragraph("<b>3단계. 가족(아이/배우자) 폰에 일정 공유</b>", styles['SecTitle']))
    share_desc = Paragraph(
        "<b>① 엄마 폰:</b> [스케줄 관리] &gt; <b>[파일 내려받기]</b>로 .json 파일 저장 후 카카오톡 전송<br/>"
        "<b>② 가족 폰:</b> 카톡으로 받은 파일 저장 &gt; 'flying mom' 접속 &gt; <b>[스케줄 관리] &gt; [파일 올리기]</b>로 파일 선택 시 즉시 등록 완료!",
        styles['Body']
    )
    t_share = Table([[share_desc]], colWidths=[CONTENT_WIDTH])
    t_share.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), KAL_BG_SKY),
        ('BOX', (0, 0), (-1, -1), 0.8, KAL_BORDER),
        ('ROUNDEDCORNERS', [2*mm, 2*mm, 2*mm, 2*mm]),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_share)
    story.append(Spacer(1, 2))

    # shot 4: 488 x 288
    img4 = RLImage(r'c:\work\aflyingmom\shot_kal_step4.png', width=CONTENT_WIDTH, height=48.0*mm)
    story.append(img4)
    story.append(Spacer(1, 4))

    # 메인 화면 보는 법
    story.append(Paragraph("<b>메인 화면 보는 법 (실시간 상태 안내)</b>", styles['SecTitle']))
    status_items = [
        ("우리 집", "비행을 마치고 한국 집에 머무르는 중 (다음 비행 일정 안내)"),
        ("예정상 비행 중", "스케줄 출발~도착 시각 사이 비행 중 (지도에 실시간 비행 위치 표시)"),
        ("예정상 해외 체류 중", "목적지 도착 후 현지에 체류 중 (현지 시각 및 날씨 표시)"),
        ("일정 확인 필요", "해당 월에 등록된 스케줄이 없을 때 표시 (임의로 위치 단정 안 함)")
    ]
    st_rows = []
    for badge, desc in status_items:
        b_p = Paragraph(f"<font color='#051766'><b>{badge}</b></font>", styles['BodyBold'])
        d_p = Paragraph(desc, styles['Body'])
        st_rows.append([b_p, d_p])

    t_status = Table(st_rows, colWidths=[28*mm, CONTENT_WIDTH - 28*mm])
    t_status.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), KAL_BG_SKY),
        ('BACKGROUND', (1, 0), (1, -1), WHITE),
        ('BOX', (0, 0), (-1, -1), 0.7, KAL_BORDER),
        ('INNERGRID', (0, 0), (-1, -1), 0.4, KAL_BORDER),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
    ]))
    story.append(t_status)
    story.append(Spacer(1, 4))

    # 화면 속 편리한 기능들
    summary_text = Paragraph(
        "<b>알아두면 유용한 기능들:</b><br/>"
        "• <b>현지 시각 & 날씨:</b> 엄마가 머무는 나라의 낮/밤 여부와 기온을 보여줘요.<br/>"
        "• <b>세계 지도:</b> 비행기가 어디서 어디로 날아가는지 비행 경로가 보여요.<br/>"
        "• <b>새로고침 [새로고침]:</b> 우측 상단 회전 화살표를 누르면 최신 정보로 갱신돼요.",
        styles['Body']
    )
    t_summary = Table([[summary_text]], colWidths=[CONTENT_WIDTH])
    t_summary.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), WHITE),
        ('BOX', (0, 0), (-1, -1), 0.6, KAL_BORDER),
        ('ROUNDEDCORNERS', [2*mm, 2*mm, 2*mm, 2*mm]),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(t_summary)

    doc.build(story, canvasmaker=CompactKALCanvas)
    doc_check = pymupdf.open(filename)
    print(f"[OK] Compact Korean Air Manual PDF generated: {filename} ({len(doc_check)} pages)")

if __name__ == '__main__':
    build_koreanair_manual("엄마의_비행_사용설명서.pdf")
