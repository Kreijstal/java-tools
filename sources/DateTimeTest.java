import java.util.Date;
import java.util.TimeZone;
import java.util.Calendar;

public class DateTimeTest {
    public static void main(String[] args) {
        System.out.println("Testing Date, TimeZone, and Calendar...");

        Date date = new Date();
        System.out.println("Date created.");

        int year = date.getYear();
        System.out.println("date.getYear() returned.");

        TimeZone tz = TimeZone.getTimeZone("GMT");
        System.out.println("TimeZone created.");

        Calendar cal = Calendar.getInstance(tz);
        System.out.println("Calendar instance created.");

        cal.setTime(date);
        System.out.println("Calendar.setTime() called.");

        int calYear = cal.get(Calendar.YEAR);
        System.out.println("Calendar.get(YEAR) returned: " + calYear);

        int calMonth = cal.get(Calendar.MONTH);
        System.out.println("Calendar.get(MONTH) returned: " + calMonth);

        int calDate = cal.get(Calendar.DATE);
        System.out.println("Calendar.get(DATE) returned: " + calDate);

        System.out.println("Test finished.");
    }
}
