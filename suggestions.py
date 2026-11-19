"""Curated micro-actions. Durations are minutes and include the first step."""

SCENES = {"waiting", "desk", "outside", "home"}
ENERGIES = {"low", "steady", "high"}
BUDGETS = {3, 5, 10, 15}

# Each scene has several choices for every energy level, even at three minutes.
SCENE_ACTIONS = {
    "waiting": [
        ("window", "看看远处的颜色", "把视线从屏幕移开，挑一种远处的颜色。", "让眼睛在那种颜色上停一会儿。轮到你时，随时收尾。", 2, "observe"),
        ("sounds", "听听身边的三种声音", "先听一听，离你最近的声音是什么？", "再找一种稍远的声音。要是愿意，试着分辨最远的那一种。", 2, "listen"),
        ("queue", "发现一个顺手的设计", "看看附近的标识，找一个一眼就懂的符号。", "想想它靠颜色、形状还是位置让你看懂。", 3, "explore"),
    ],
    "desk": [
        ("pen", "给桌面留一点空白", "把手边一件暂时用不到的小东西放回原处。", "看看腾出来的那一小块地方，一件就够了。", 2, "tidy"),
        ("focus", "把目光送到远处", "抬起头，选一个房间另一端的物件。", "慢慢看清它的轮廓，再把目光带回眼前。", 1, "observe"),
        ("deskshape", "找一组藏起来的形状", "在桌面上找一个圆形，再找一个方形。", "看看哪种形状更常见，猜猜设计者为什么选它。", 3, "explore"),
    ],
    "outside": [
        ("sky", "抬头收集一片天空", "先在安全的位置站定，抬头看一小片天空。", "看看它今天是什么颜色，也可以留意楼顶和天空的交界线。", 2, "observe"),
        ("streetsound", "听一听街角的声音", "在安全的地方停下，留意身边一种声音。", "听它靠近或远去，给这段街头声音想个名字。", 2, "listen"),
        ("sign", "找一个街角的小细节", "在安全的位置站定，看看附近的一块招牌。", "挑一个有意思的笔画，顺着它的轮廓看一圈。", 3, "explore"),
    ],
    "home": [
        ("light", "追一小块光影", "看看房间里，哪儿有一块亮一些的地方？", "顺着它的边缘看一圈，找找光是从哪里来的。", 2, "observe"),
        ("shelf", "让一件小物归位", "挑一件就在手边的小物件。", "把它放到下次最容易找到的位置，到这里就可以了。", 2, "tidy"),
        ("homelisten", "听听房间自己的声音", "安静片刻，听听房间里持续最久的声音。", "留意它中间的停顿，再慢慢把注意力放回来。", 2, "listen"),
    ],
}

EXTRAS = {
    "low": [
        ("pause", "给自己一分钟放空", "在方便停留的地方歇一会儿，把手机放低。", "让肩膀自然放松。什么都不用完成，休息一会儿就好。", 1, "rest"),
    ],
    "steady": [
        ("headline", "给此刻起个名字", "看看身边，选一个最吸引你注意的小细节。", "把它放进一个短短的标题里，就当是今天生活的一行注脚。", 3, "explore"),
        ("palette", "收集一组今日配色", "停下来，先选出身边最显眼的一种颜色。", "再找两种和它相配的颜色，给这组配色起个名字。", 5, "observe"),
    ],
    "high": [
        ("invent", "试一次小小的发明", "在方便停留的地方，挑一样眼前的日常用品。", "为它想一种新用途，越具体越有趣。", 3, "explore"),
        ("story", "给眼前的小物编个故事", "选一件眼前的小物，想象它是故事的主角。", "想一想它刚从哪里来，又打算去哪里。把故事浓缩成三句话。", 5, "explore"),
    ],
}


def options(scene, energy, budget):
    items = SCENE_ACTIONS[scene] + EXTRAS[energy]
    return [item for item in items if item[4] <= budget and
            (energy != "low" or item[5] != "explore")]
